import { getTokyoToday, isValidDate } from "../lib/dates.js";
import { withCors, jsonError } from "../lib/http.js";

const ALLOWED_PRODUCT_ID = "salvia-standard";
const DEFAULT_DAYS = 31;
const MAX_DAYS = 62;
const MIN_PRICE_JPY = 1000;
const MAX_PRICE_JPY = 1000000;

function isAdminAuthorized(request, env) {
  const authorization = request.headers.get("Authorization");
  return Boolean(
    env.ADMIN_DASHBOARD_TOKEN &&
    authorization === `Bearer ${env.ADMIN_DASHBOARD_TOKEN}`
  );
}

function dateToUtc(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function addDays(dateString, amount) {
  const date = new Date(dateToUtc(dateString));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dateRange(startDate, days) {
  const values = [];
  for (let index = 0; index < days; index += 1) {
    values.push(addDays(startDate, index));
  }
  return values;
}

function normalizeMinNightsOverride(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 30) {
    return undefined;
  }
  return parsed;
}

export async function handleRateAdminRoutes(request, env, url) {
  if (!url.pathname.startsWith("/api/admin/rates")) {
    return null;
  }

  if (!isAdminAuthorized(request, env)) {
    return withCors(
      Response.json(
        { ok: false, error: "unauthorized" },
        { status: 401 }
      ),
      request
    );
  }

  /*
   * 管理者用：料金カレンダー取得
   *
   * 指定期間を日付ごとに返す。
   * rate_calendar に行がない日は rate_exists=false とし、
   * 管理画面側で「料金未設定」と表示する。
   */
  if (
    url.pathname === "/api/admin/rates" &&
    request.method === "GET"
  ) {
    try {
      const productId = String(
        url.searchParams.get("product_id") || ALLOWED_PRODUCT_ID
      ).trim();
      const startDate = String(
        url.searchParams.get("start") || getTokyoToday()
      ).trim();
      const days = Number(
        url.searchParams.get("days") || DEFAULT_DAYS
      );

      if (productId !== ALLOWED_PRODUCT_ID) {
        return withCors(
          jsonError("unsupported_product", 400),
          request
        );
      }

      if (!isValidDate(startDate)) {
        return withCors(
          jsonError("invalid_start_date", 400),
          request
        );
      }

      if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
        return withCors(
          jsonError("invalid_days", 400),
          request
        );
      }

      const product = await env.DB
        .prepare(`
          SELECT
            id,
            name,
            min_nights,
            max_guests,
            status
          FROM products
          WHERE id = ?
          LIMIT 1
        `)
        .bind(productId)
        .first();

      if (!product) {
        return withCors(
          jsonError("product_not_found", 404),
          request
        );
      }

      const dates = dateRange(startDate, days);
      const endExclusive = addDays(startDate, days);

      const rateResult = await env.DB
        .prepare(`
          SELECT
            product_id,
            stay_date,
            price_jpy,
            is_open,
            min_nights_override,
            note,
            created_at,
            updated_at
          FROM rate_calendar
          WHERE product_id = ?
            AND stay_date >= ?
            AND stay_date < ?
          ORDER BY stay_date
        `)
        .bind(productId, startDate, endExclusive)
        .all();

      const allocationResult = await env.DB
        .prepare(`
          SELECT
            i.stay_date,
            MAX(
              CASE
                WHEN i.allocation_type = 'booking' THEN 2
                WHEN i.allocation_type = 'hold'
                  AND i.expires_at IS NOT NULL
                  AND datetime(i.expires_at) > CURRENT_TIMESTAMP
                THEN 1
                ELSE 0
              END
            ) AS allocation_rank
          FROM inventory_nights i
          JOIN product_units pu
            ON pu.unit_id = i.unit_id
          WHERE pu.product_id = ?
            AND i.stay_date >= ?
            AND i.stay_date < ?
            AND (
              i.allocation_type = 'booking'
              OR (
                i.allocation_type = 'hold'
                AND i.expires_at IS NOT NULL
                AND datetime(i.expires_at) > CURRENT_TIMESTAMP
              )
            )
          GROUP BY i.stay_date
          ORDER BY i.stay_date
        `)
        .bind(productId, startDate, endExclusive)
        .all();

      const rateMap = new Map(
        rateResult.results.map((row) => [row.stay_date, row])
      );
      const allocationMap = new Map(
        allocationResult.results.map((row) => [
          row.stay_date,
          Number(row.allocation_rank || 0),
        ])
      );

      const rows = dates.map((stayDate) => {
        const rate = rateMap.get(stayDate);
        const allocationRank = allocationMap.get(stayDate) || 0;

        return {
          stay_date: stayDate,
          rate_exists: Boolean(rate),
          price_jpy: rate?.price_jpy ?? null,
          is_open: rate ? rate.is_open === 1 : false,
          min_nights_override: rate?.min_nights_override ?? null,
          note: rate?.note ?? null,
          created_at: rate?.created_at ?? null,
          updated_at: rate?.updated_at ?? null,
          occupancy:
            allocationRank === 2
              ? "booking"
              : allocationRank === 1
                ? "hold"
                : null,
        };
      });

      return withCors(
        Response.json({
          ok: true,
          product,
          start_date: startDate,
          days,
          rows,
        }),
        request
      );
    } catch (error) {
      console.error("Admin rates API error:", error);
      return withCors(
        jsonError("internal_server_error", 500),
        request
      );
    }
  }

  /*
   * 管理者用：1日分の料金・販売状態更新
   *
   * 既存予約・在庫割当には一切触れない。
   * rate_calendar のみ更新する。
   *
   * expected_updated_at を使い、管理画面で表示後に別操作で
   * 変更された場合は上書きせず 409 を返す。
   */
  if (
    url.pathname === "/api/admin/rates/update" &&
    request.method === "POST"
  ) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return withCors(
          jsonError("invalid_json", 400),
          request
        );
      }

      if (body.confirm !== true) {
        return withCors(
          jsonError("confirmation_required", 400),
          request
        );
      }

      const productId = String(body.product_id || "").trim();
      const stayDate = String(body.stay_date || "").trim();
      const priceJpy = Number(body.price_jpy);
      const isOpen = body.is_open;
      const minNightsOverride = normalizeMinNightsOverride(
        body.min_nights_override
      );
      const expectedUpdatedAt =
        body.expected_updated_at === null ||
        body.expected_updated_at === undefined ||
        body.expected_updated_at === ""
          ? null
          : String(body.expected_updated_at);

      if (productId !== ALLOWED_PRODUCT_ID) {
        return withCors(
          jsonError("unsupported_product", 400),
          request
        );
      }

      if (!isValidDate(stayDate)) {
        return withCors(
          jsonError("invalid_stay_date", 400),
          request
        );
      }

      if (stayDate < getTokyoToday()) {
        return withCors(
          jsonError("past_date_not_editable", 409),
          request
        );
      }

      if (
        !Number.isInteger(priceJpy) ||
        priceJpy < MIN_PRICE_JPY ||
        priceJpy > MAX_PRICE_JPY
      ) {
        return withCors(
          jsonError("invalid_price", 400),
          request
        );
      }

      if (typeof isOpen !== "boolean") {
        return withCors(
          jsonError("invalid_is_open", 400),
          request
        );
      }

      if (minNightsOverride === undefined) {
        return withCors(
          jsonError("invalid_min_nights_override", 400),
          request
        );
      }

      const product = await env.DB
        .prepare(`
          SELECT id, status
          FROM products
          WHERE id = ?
          LIMIT 1
        `)
        .bind(productId)
        .first();

      if (!product || product.status !== "active") {
        return withCors(
          jsonError("product_not_active", 409),
          request
        );
      }

      const current = await env.DB
        .prepare(`
          SELECT
            product_id,
            stay_date,
            price_jpy,
            is_open,
            min_nights_override,
            note,
            created_at,
            updated_at
          FROM rate_calendar
          WHERE product_id = ?
            AND stay_date = ?
          LIMIT 1
        `)
        .bind(productId, stayDate)
        .first();

      if (current) {
        if (
          expectedUpdatedAt === null ||
          String(current.updated_at) !== expectedUpdatedAt
        ) {
          return withCors(
            Response.json(
              {
                ok: false,
                error: "rate_changed",
                current: {
                  price_jpy: current.price_jpy,
                  is_open: current.is_open === 1,
                  min_nights_override: current.min_nights_override,
                  updated_at: current.updated_at,
                },
              },
              { status: 409 }
            ),
            request
          );
        }
      } else if (expectedUpdatedAt !== null) {
        return withCors(
          jsonError("rate_changed", 409),
          request
        );
      }

      if (current) {
        await env.DB
          .prepare(`
            UPDATE rate_calendar
            SET
              price_jpy = ?,
              is_open = ?,
              min_nights_override = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE product_id = ?
              AND stay_date = ?
          `)
          .bind(
            priceJpy,
            isOpen ? 1 : 0,
            minNightsOverride,
            productId,
            stayDate
          )
          .run();
      } else {
        await env.DB
          .prepare(`
            INSERT INTO rate_calendar (
              product_id,
              stay_date,
              price_jpy,
              is_open,
              min_nights_override,
              note
            ) VALUES (?, ?, ?, ?, ?, NULL)
          `)
          .bind(
            productId,
            stayDate,
            priceJpy,
            isOpen ? 1 : 0,
            minNightsOverride
          )
          .run();
      }

      const updated = await env.DB
        .prepare(`
          SELECT
            product_id,
            stay_date,
            price_jpy,
            is_open,
            min_nights_override,
            note,
            created_at,
            updated_at
          FROM rate_calendar
          WHERE product_id = ?
            AND stay_date = ?
          LIMIT 1
        `)
        .bind(productId, stayDate)
        .first();

      return withCors(
        Response.json({
          ok: true,
          rate: {
            ...updated,
            is_open: updated?.is_open === 1,
          },
        }),
        request
      );
    } catch (error) {
      console.error("Admin rate update error:", error);
      return withCors(
        jsonError("internal_server_error", 500),
        request
      );
    }
  }

  return null;
}
