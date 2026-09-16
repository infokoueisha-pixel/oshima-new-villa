import { HOLD_MINUTES } from "../config.js";
import { isValidDate, getStayDates, toSqlUtc, getTokyoToday, getCancellationPolicyRate } from "../lib/dates.js";
import { withCors, jsonError } from "../lib/http.js";
import { sendCancellationCompletionEmail, sendAdminCancellationNotificationEmail } from "../services/emails.js";
import { createPublicBookingCode, sha256, createFingerprint, getAvailability, getBookingByIdempotencyKey, existingBookingResponse } from "../services/booking.js";

export async function handleBookingRoutes(request, env, url) {
    /*
     * 空室・料金確認
     */
    if (
      url.pathname ===
        "/api/availability" &&
      request.method === "GET"
    ) {
      try {
        const productId =
          url.searchParams.get(
            "product"
          );

        const checkIn =
          url.searchParams.get(
            "check_in"
          );

        const checkOut =
          url.searchParams.get(
            "check_out"
          );

        if (
          !productId ||
          !checkIn ||
          !checkOut
        ) {
          return jsonError(
            "product_check_in_and_check_out_are_required"
          );
        }

        if (
          !isValidDate(checkIn) ||
          !isValidDate(checkOut)
        ) {
          return jsonError(
            "invalid_date_format"
          );
        }

        if (
          checkOut <= checkIn
        ) {
          return jsonError(
            "check_out_must_be_after_check_in"
          );
        }

        const nights =
          getStayDates(
            checkIn,
            checkOut
          ).length;

        if (
          nights < 1 ||
          nights > 30
        ) {
          return jsonError(
            "stay_length_not_allowed"
          );
        }

        const result =
          await getAvailability(
            env,
            productId,
            checkIn,
            checkOut
          );

        if (!result.ok) {
          return jsonError(
            result.error,
            404
          );
        }

        return withCors(
          Response.json({
          ok: true,

          product_id:
            result.product.id,

          product_name:
            result.product.name,

          check_in:
            checkIn,

          check_out:
            checkOut,

          nights:
            result.nights,

          minimum_nights:
            result.minimumNights,

          max_guests:
            result.product
              .max_guests,

          currency:
            result.product
              .currency,

          nightly_rates:
            result.nightlyRates,

          total_price_jpy:
            result.totalPrice,

          available:
            result.available,

          reason:
            result.reason,

          unavailable_dates:
      result.unavailableDates,
  }),
  request
);
      } catch (error) {
        console.error(
          "Availability error:",
          error
        );

        return jsonError(
          "internal_server_error",
          500
        );
      }
    }

    /*
     * 仮予約作成
     */
    if (
      url.pathname ===
        "/api/holds" &&
      request.method === "POST"
    ) {
      try {
        /*
         * Idempotency-Key
         */
        const idempotencyKey =
          request.headers.get(
            "Idempotency-Key"
          );

        if (!idempotencyKey) {
          return jsonError(
            "idempotency_key_required"
          );
        }

        if (
          idempotencyKey.length < 8 ||
          idempotencyKey.length > 128
        ) {
          return jsonError(
            "invalid_idempotency_key"
          );
        }

        /*
         * JSON取得
         */
        let body;

        try {
          body =
            await request.json();
        } catch {
          return jsonError(
            "invalid_json"
          );
        }

        let {
          product_id,
          check_in,
          check_out,
          guest_count,
          customer_name,
          customer_email,
          customer_phone,
          terms_accepted,
          cancellation_policy_accepted,
        } = body;

        /*
         * 必須項目
         */
        if (
          !product_id ||
          !check_in ||
          !check_out ||
          !customer_name ||
          !customer_email
        ) {
          return jsonError(
            "required_fields_are_missing"
          );
        }

        /*
         * 正規化
         */
        product_id =
          String(product_id).trim();

        customer_name =
          String(customer_name).trim();

        customer_email =
          String(customer_email)
            .trim()
            .toLowerCase();

        customer_phone =
          customer_phone == null
            ? null
            : String(
                customer_phone
              ).trim();

        const parsedGuestCount =
          Number(guest_count);

        /*
         * 入力値チェック
         */
        if (
          !isValidDate(check_in) ||
          !isValidDate(check_out)
        ) {
          return jsonError(
            "invalid_date_format"
          );
        }

        if (
          check_out <= check_in
        ) {
          return jsonError(
            "check_out_must_be_after_check_in"
          );
        }

        if (
          !Number.isInteger(
            parsedGuestCount
          ) ||
          parsedGuestCount < 1
        ) {
          return jsonError(
            "invalid_guest_count"
          );
        }

        if (
          customer_name.length < 1 ||
          customer_name.length > 100
        ) {
          return jsonError(
            "invalid_customer_name"
          );
        }

        if (
          customer_email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/
            .test(customer_email)
        ) {
          return jsonError(
            "invalid_customer_email"
          );
        }

        if (
          customer_phone &&
          customer_phone.length > 40
        ) {
          return jsonError(
            "invalid_customer_phone"
          );
        }

        if (
          terms_accepted !== true
        ) {
          return jsonError(
            "terms_must_be_accepted"
          );
        }

        if (
          cancellation_policy_accepted
            !== true
        ) {
          return jsonError(
            "cancellation_policy_must_be_accepted"
          );
        }

        const nights =
          getStayDates(
            check_in,
            check_out
          ).length;

        if (
          nights < 1 ||
          nights > 30
        ) {
          return jsonError(
            "stay_length_not_allowed"
          );
        }

        /*
         * リクエスト内容の指紋を作る
         */
        const fingerprint =
          await createFingerprint({
            product_id,
            check_in,
            check_out,
            guest_count:
              parsedGuestCount,
            customer_name,
            customer_email,
            customer_phone,
          });

        /*
         * 同じIdempotency-Keyが
         * すでに存在するか
         */
        const existingBooking =
          await getBookingByIdempotencyKey(
            env,
            idempotencyKey
          );

        if (existingBooking) {
          if (
            existingBooking
              .idempotency_fingerprint
            !== fingerprint
          ) {
            return jsonError(
              "idempotency_key_conflict",
              409
            );
          }

          /*
           * 同じキー＋同じ内容なら
           * 新規予約を作らず
           * 既存予約を返す
           */
          return existingBookingResponse(
            existingBooking,
            true
          );
        }

        /*
         * 料金・空室を
         * サーバー側で再確認
         */
        const availability =
          await getAvailability(
            env,
            product_id,
            check_in,
            check_out
          );

        if (!availability.ok) {
          return jsonError(
            availability.error,
            404
          );
        }

        if (
          parsedGuestCount >
          availability.product
            .max_guests
        ) {
          return jsonError(
            "guest_count_exceeds_capacity"
          );
        }

        if (
          !availability.available
        ) {
          return jsonError(
            "not_available",
            409,
            {
              reason:
                availability.reason,

              unavailable_dates:
                availability
                  .unavailableDates,
            }
          );
        }

        /*
         * キャンセルポリシー
         */
        const policyId =
          availability.product
            .cancellation_policy_id;

        if (!policyId) {
          return jsonError(
            "cancellation_policy_not_configured",
            500
          );
        }

        const policy =
          await env.DB
            .prepare(`
              SELECT
                id,
                version_code,
                policy_text
              FROM cancellation_policies
              WHERE id = ?
                AND status = 'active'
              LIMIT 1
            `)
            .bind(policyId)
            .first();

        if (!policy) {
          return jsonError(
            "cancellation_policy_not_found",
            500
          );
        }

        /*
         * 商品が使用する棟
         */
        const unitResult =
          await env.DB
            .prepare(`
              SELECT unit_id
              FROM product_units
              WHERE product_id = ?
              ORDER BY unit_id
            `)
            .bind(product_id)
            .all();

        const unitIds =
          unitResult.results.map(
            (row) => row.unit_id
          );

        if (
          unitIds.length === 0
        ) {
          return jsonError(
            "product_units_not_configured",
            500
          );
        }

        /*
         * 予約ID発行
         */
        const bookingId =
          crypto.randomUUID();

        const publicBookingCode =
          createPublicBookingCode();

        const expiresAtDate =
          new Date(
            Date.now() +
              HOLD_MINUTES *
                60 *
                1000
          );

        const expiresAt =
          toSqlUtc(
            expiresAtDate
          );

        /*
         * DBトランザクション
         */
        const statements = [];

        /*
         * 同日・同棟の
         * 期限切れholdだけ削除
         */
        for (
          const unitId of unitIds
        ) {
          for (
            const stayDate of
            availability.stayDates
          ) {
            statements.push(
              env.DB
                .prepare(`
                  DELETE
                  FROM inventory_nights
                  WHERE unit_id = ?
                    AND stay_date = ?
                    AND allocation_type = 'hold'
                    AND expires_at IS NOT NULL
                    AND datetime(expires_at)
                      <= CURRENT_TIMESTAMP
                `)
                .bind(
                  unitId,
                  stayDate
                )
            );
          }
        }

        /*
         * 予約本体
         */
        statements.push(
          env.DB
            .prepare(`
              INSERT INTO bookings (
                id,
                public_booking_code,

                product_id,

                check_in_date,
                check_out_date,

                guest_count,

                subtotal_jpy,
                discount_jpy,
                total_jpy,

                status,
                payment_status,

                customer_name,
                customer_email,
                customer_phone,

                cancellation_policy_version,
                cancellation_policy_snapshot,

                hold_expires_at,

                terms_accepted_at,
                cancellation_policy_accepted_at,

                idempotency_key,
                idempotency_fingerprint
              ) VALUES (
                ?, ?,
                ?,
                ?, ?,
                ?,
                ?, 0, ?,
                'pending_payment',
                'unpaid',
                ?, ?, ?,
                ?, ?,
                ?,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP,
                ?, ?
              )
            `)
            .bind(
              bookingId,
              publicBookingCode,

              product_id,

              check_in,
              check_out,

              parsedGuestCount,

              availability.totalPrice,
              availability.totalPrice,

              customer_name,
              customer_email,
              customer_phone,

              policy.version_code,
              policy.policy_text,

              expiresAt,

              idempotencyKey,
              fingerprint
            )
        );

  /*
 * 期限切れ・未決済予約を
 * expiredへ変更する。
 */
statements.push(
  env.DB
    .prepare(`
      UPDATE bookings
      SET
        status = 'expired',
        updated_at = CURRENT_TIMESTAMP
      WHERE status = 'pending_payment'
        AND payment_status = 'unpaid'
        AND hold_expires_at IS NOT NULL
        AND datetime(hold_expires_at)
          <= CURRENT_TIMESTAMP
    `)
);

        /*
 * 宿泊日ごとの
 * 実在庫hold
 */
for (
  const unitId of unitIds
) {
  for (
    const stayDate of
      availability.stayDates
  ) {
    
    /*
     * 同じ部屋・宿泊日に残っている
     * 期限切れholdを回収する。
     *
     * booking と有効期限内のholdは
     * 絶対に削除しない。
     */
    statements.push(
      env.DB
        .prepare(`
          DELETE FROM inventory_nights
          WHERE unit_id = ?
            AND stay_date = ?
            AND allocation_type = 'hold'
            AND expires_at IS NOT NULL
            AND datetime(expires_at)
              <= CURRENT_TIMESTAMP
        `)
        .bind(
          unitId,
          stayDate
        )
    );

    statements.push(
      env.DB
        .prepare(`
          INSERT INTO inventory_nights (
            unit_id,
            stay_date,
            allocation_type,
            allocation_ref,
            expires_at
          ) VALUES (
            ?,
            ?,
            'hold',
            ?,
            ?
          )
        `)
        .bind(
          unitId,
          stayDate,
          bookingId,
          expiresAt
        )
    );
  }
}

        try {
          await env.DB.batch(
            statements
          );
        } catch (error) {
          console.error(
            "Hold transaction error:",
            error
          );

          /*
           * 同じIdempotency-Keyの
           * 同時POSTだった可能性を確認
           */
          const afterErrorBooking =
            await getBookingByIdempotencyKey(
              env,
              idempotencyKey
            );

          if (afterErrorBooking) {
            if (
              afterErrorBooking
                .idempotency_fingerprint
              !== fingerprint
            ) {
              return jsonError(
                "idempotency_key_conflict",
                409
              );
            }

            return existingBookingResponse(
              afterErrorBooking,
              true
            );
          }

          const message =
            String(
              error?.message || ""
            );

          /*
           * 別のお客様に
           * 在庫を先に取られた
           */
          if (
            message.includes(
              "UNIQUE constraint failed"
            ) ||
            message.includes(
              "SQLITE_CONSTRAINT"
            )
          ) {
            return jsonError(
              "inventory_changed",
              409
            );
          }

          throw error;
        }

        /*
         * 新規仮予約成功
         */
        return withCors(
         Response.json(
          {
            ok: true,

            booking_id:
              bookingId,

            booking_code:
              publicBookingCode,

            status:
              "pending_payment",

            payment_status:
              "unpaid",

            product_id,

            product_name:
              availability.product
                .name,

            check_in,
            check_out,

            nights:
              availability.nights,

            guest_count:
              parsedGuestCount,

            currency:
              availability.product
                .currency,

            total_price_jpy:
              availability.totalPrice,

            hold_expires_at:
              expiresAt,

            hold_minutes:
              HOLD_MINUTES,

            idempotency_replayed:
              false,
              },
              { status: 201 }
           ),
          request
        );
      } catch (error) {
        console.error(
          "Hold API error:",
          error
        );

        return jsonError(
          "internal_server_error",
          500
        );
      }
    }

  return null;
}
