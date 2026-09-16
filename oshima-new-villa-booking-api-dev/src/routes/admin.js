import { HOLD_MINUTES } from "../config.js";
import { isValidDate, getStayDates, toSqlUtc, getTokyoToday, getCancellationPolicyRate } from "../lib/dates.js";
import { withCors, jsonError } from "../lib/http.js";
import { sendCancellationCompletionEmail, sendAdminCancellationNotificationEmail } from "../services/emails.js";
import { sendBookingConfirmationEmail } from "../services/booking-confirmation-email.js";
import { createPublicBookingCode, sha256, createFingerprint, getAvailability, getBookingByIdempotencyKey, existingBookingResponse } from "../services/booking.js";


const ADMIN_EMAIL_TYPES = {
  booking_confirmation: {
    table: "email_deliveries",
    where: "booking_id = ? AND email_type = 'booking_confirmation'",
  },
  cancellation_completion: {
    table: "cancellation_email_deliveries",
    where: "booking_id = ?",
  },
  admin_cancellation_notification: {
    table: "admin_cancellation_email_deliveries",
    where: "booking_id = ?",
  },
};

function normalizeEmailDelivery(
  row,
  applicable
) {
  return {
    applicable,
    status:
      row?.status || null,
    recipient_email:
      row?.recipient_email || null,
    resend_email_id:
      row?.resend_email_id || null,
    last_error:
      row?.last_error || null,
    sent_at:
      row?.sent_at || null,
    updated_at:
      row?.updated_at || null,
  };
}

function isAdminAuthorized(
  request,
  env
) {
  const authorization =
    request.headers.get(
      "Authorization"
    );

  const expectedAuthorization =
    `Bearer ${env.ADMIN_DASHBOARD_TOKEN}`;

  return Boolean(
    env.ADMIN_DASHBOARD_TOKEN &&
    authorization === expectedAuthorization
  );
}

export async function handleAdminRoutes(request, env, url) {
/*
 * 管理者用：予約一覧
 */
if (
  url.pathname === "/api/admin/bookings" &&
  request.method === "GET"
) {
  const authorization =
    request.headers.get("Authorization");

  const expectedAuthorization =
    `Bearer ${env.ADMIN_DASHBOARD_TOKEN}`;

  if (
    !env.ADMIN_DASHBOARD_TOKEN ||
    authorization !== expectedAuthorization
  ) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: "unauthorized",
        },
        { status: 401 }
      ),
      request
    );
  }

  try {
    const result = await env.DB
      .prepare(`
        SELECT
          b.id,
          b.public_booking_code,
          b.product_id,
          b.check_in_date,
          b.check_out_date,
          CAST(
            julianday(b.check_out_date) -
            julianday(b.check_in_date)
            AS INTEGER
          ) AS nights,
          b.guest_count,
          b.customer_name,
          b.customer_email,
          b.customer_phone,
          b.total_jpy,
          b.status,
          b.payment_status,
          b.confirmed_at,
          b.hold_expires_at,
          b.created_at,
          b.updated_at,

          (
            SELECT GROUP_CONCAT(
              DISTINCT i.allocation_type
            )
            FROM inventory_nights i
            WHERE i.allocation_ref = b.id
          ) AS inventory_type

        FROM bookings b
        ORDER BY datetime(b.created_at) DESC
        LIMIT 100
      `)
      .all();

    return withCors(
      Response.json({
        ok: true,
        bookings: result.results,
      }),
      request
    );
  } catch (error) {
    console.error(
      "Admin bookings API error:",
      error
    );

    return withCors(
      Response.json(
        {
          ok: false,
          error: "internal_server_error",
        },
        { status: 500 }
      ),
      request
    );
  }
}    



/*
 * 管理者用：予約詳細
 *
 * 予約本体・キャンセル/返金・現在の在庫割当・
 * メール送信履歴を1画面で確認するための読取専用API。
 */
if (
  url.pathname ===
    "/api/admin/booking-detail" &&
  request.method === "GET"
) {
  if (
    !isAdminAuthorized(
      request,
      env
    )
  ) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: "unauthorized",
        },
        { status: 401 }
      ),
      request
    );
  }

  try {
    const bookingCode =
      String(
        url.searchParams.get(
          "booking_code"
        ) || ""
      ).trim();

    if (!bookingCode) {
      return withCors(
        jsonError(
          "booking_code_required"
        ),
        request
      );
    }

    const booking =
      await env.DB
        .prepare(`
          SELECT
            b.id,
            b.public_booking_code,
            b.product_id,
            p.name AS product_name,

            b.check_in_date,
            b.check_out_date,
            CAST(
              julianday(b.check_out_date) -
              julianday(b.check_in_date)
              AS INTEGER
            ) AS nights,

            b.guest_count,
            b.subtotal_jpy,
            b.discount_jpy,
            b.total_jpy,

            b.status,
            b.payment_status,

            b.customer_name,
            b.customer_email,
            b.customer_phone,

            b.stripe_checkout_session_id,
            b.stripe_payment_intent_id,

            b.cancellation_policy_version,
            b.cancellation_policy_snapshot,

            b.hold_expires_at,
            b.terms_accepted_at,
            b.cancellation_policy_accepted_at,

            b.created_at,
            b.confirmed_at,
            b.cancelled_at,
            b.updated_at

          FROM bookings b
          JOIN products p
            ON p.id = b.product_id

          WHERE b.public_booking_code = ?
          LIMIT 1
        `)
        .bind(bookingCode)
        .first();

    if (!booking) {
      return withCors(
        jsonError(
          "booking_not_found",
          404
        ),
        request
      );
    }

    const results =
      await env.DB.batch([
        env.DB
          .prepare(`
            SELECT
              reason_code,
              policy_rate,
              cancellation_fee_jpy,
              refund_amount_jpy,
              stripe_refund_id,
              stripe_refund_status,
              admin_note,
              created_at,
              updated_at
            FROM booking_cancellations
            WHERE booking_id = ?
            LIMIT 1
          `)
          .bind(booking.id),

        env.DB
          .prepare(`
            SELECT
              stay_date,
              allocation_type,
              expires_at,
              created_at,
              updated_at
            FROM inventory_nights
            WHERE allocation_ref = ?
            ORDER BY stay_date
          `)
          .bind(booking.id),

        env.DB
          .prepare(`
            SELECT
              email_type,
              recipient_email,
              resend_email_id,
              status,
              last_error,
              sent_at,
              created_at,
              updated_at
            FROM email_deliveries
            WHERE booking_id = ?
            ORDER BY datetime(created_at)
          `)
          .bind(booking.id),

        env.DB
          .prepare(`
            SELECT
              'cancellation_completion' AS email_type,
              recipient_email,
              resend_email_id,
              status,
              last_error,
              sent_at,
              created_at,
              updated_at
            FROM cancellation_email_deliveries
            WHERE booking_id = ?
            LIMIT 1
          `)
          .bind(booking.id),

        env.DB
          .prepare(`
            SELECT
              'admin_cancellation_notification' AS email_type,
              recipient_email,
              resend_email_id,
              status,
              last_error,
              sent_at,
              created_at,
              updated_at
            FROM admin_cancellation_email_deliveries
            WHERE booking_id = ?
            LIMIT 1
          `)
          .bind(booking.id),
      ]);

    const cancellation =
      results[0]?.results?.[0] ||
      null;

    const inventory =
      results[1]?.results || [];

    const emailDeliveries = [
      ...(results[2]?.results || []),
      ...(results[3]?.results || []),
      ...(results[4]?.results || []),
    ].sort((a, b) =>
      String(a.created_at || "")
        .localeCompare(
          String(b.created_at || "")
        )
    );

    return withCors(
      Response.json({
        ok: true,

        booking: {
          booking_code:
            booking.public_booking_code,
          product_id:
            booking.product_id,
          product_name:
            booking.product_name,
          check_in:
            booking.check_in_date,
          check_out:
            booking.check_out_date,
          nights:
            booking.nights,
          guest_count:
            booking.guest_count,
          subtotal_jpy:
            booking.subtotal_jpy,
          discount_jpy:
            booking.discount_jpy,
          total_jpy:
            booking.total_jpy,
          status:
            booking.status,
          payment_status:
            booking.payment_status,
          customer_name:
            booking.customer_name,
          customer_email:
            booking.customer_email,
          customer_phone:
            booking.customer_phone,
          stripe_checkout_session_id:
            booking.stripe_checkout_session_id,
          stripe_payment_intent_id:
            booking.stripe_payment_intent_id,
          cancellation_policy_version:
            booking.cancellation_policy_version,
          cancellation_policy_snapshot:
            booking.cancellation_policy_snapshot,
          hold_expires_at:
            booking.hold_expires_at,
          terms_accepted_at:
            booking.terms_accepted_at,
          cancellation_policy_accepted_at:
            booking.cancellation_policy_accepted_at,
          created_at:
            booking.created_at,
          confirmed_at:
            booking.confirmed_at,
          cancelled_at:
            booking.cancelled_at,
          updated_at:
            booking.updated_at,
        },

        cancellation,
        inventory,
        email_deliveries:
          emailDeliveries,
      }),
      request
    );
  } catch (error) {
    console.error(
      "Admin booking detail API error:",
      error
    );

    return withCors(
      jsonError(
        "internal_server_error",
        500
      ),
      request
    );
  }
}

/*
 * 管理者用：予約メール送信状況
 */
if (
  url.pathname ===
    "/api/admin/email-status" &&
  request.method === "GET"
) {
  if (
    !isAdminAuthorized(
      request,
      env
    )
  ) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: "unauthorized",
        },
        { status: 401 }
      ),
      request
    );
  }

  try {
    const bookingCode =
      String(
        url.searchParams.get(
          "booking_code"
        ) || ""
      ).trim();

    if (!bookingCode) {
      return withCors(
        jsonError(
          "booking_code_required"
        ),
        request
      );
    }

    const booking =
      await env.DB
        .prepare(`
          SELECT
            id,
            public_booking_code,
            status,
            payment_status,
            confirmed_at,
            cancelled_at
          FROM bookings
          WHERE public_booking_code = ?
          LIMIT 1
        `)
        .bind(bookingCode)
        .first();

    if (!booking) {
      return withCors(
        jsonError(
          "booking_not_found",
          404
        ),
        request
      );
    }

    const results =
      await env.DB.batch([
        env.DB
          .prepare(`
            SELECT
              recipient_email,
              resend_email_id,
              status,
              last_error,
              sent_at,
              updated_at
            FROM email_deliveries
            WHERE booking_id = ?
              AND email_type =
                'booking_confirmation'
            LIMIT 1
          `)
          .bind(booking.id),

        env.DB
          .prepare(`
            SELECT
              recipient_email,
              resend_email_id,
              status,
              last_error,
              sent_at,
              updated_at
            FROM cancellation_email_deliveries
            WHERE booking_id = ?
            LIMIT 1
          `)
          .bind(booking.id),

        env.DB
          .prepare(`
            SELECT
              recipient_email,
              resend_email_id,
              status,
              last_error,
              sent_at,
              updated_at
            FROM admin_cancellation_email_deliveries
            WHERE booking_id = ?
            LIMIT 1
          `)
          .bind(booking.id),
      ]);

    const bookingConfirmation =
      results[0]?.results?.[0] ||
      null;

    const cancellationCompletion =
      results[1]?.results?.[0] ||
      null;

    const adminCancellation =
      results[2]?.results?.[0] ||
      null;

    return withCors(
      Response.json({
        ok: true,

        booking: {
          booking_code:
            booking.public_booking_code,

          status:
            booking.status,

          payment_status:
            booking.payment_status,
        },

        emails: {
          booking_confirmation:
            normalizeEmailDelivery(
              bookingConfirmation,
              Boolean(
                booking.confirmed_at
              )
            ),

          cancellation_completion:
            normalizeEmailDelivery(
              cancellationCompletion,
              booking.status ===
                "cancelled"
            ),

          admin_cancellation_notification:
            normalizeEmailDelivery(
              adminCancellation,
              booking.status ===
                "cancelled"
            ),
        },
      }),
      request
    );
  } catch (error) {
    console.error(
      "Admin email status API error:",
      error
    );

    return withCors(
      jsonError(
        "internal_server_error",
        500
      ),
      request
    );
  }
}

/*
 * 管理者用：失敗したメールの手動再送
 *
 * failed の送信履歴だけ再送できる。
 * sent / pending は二重送信防止のため拒否する。
 */
if (
  url.pathname ===
    "/api/admin/email-resend" &&
  request.method === "POST"
) {
  if (
    !isAdminAuthorized(
      request,
      env
    )
  ) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: "unauthorized",
        },
        { status: 401 }
      ),
      request
    );
  }

  try {
    let body;

    try {
      body =
        await request.json();
    } catch {
      return withCors(
        jsonError(
          "invalid_json"
        ),
        request
      );
    }

    const bookingCode =
      String(
        body.booking_code || ""
      ).trim();

    const emailType =
      String(
        body.email_type || ""
      ).trim();

    const config =
      ADMIN_EMAIL_TYPES[
        emailType
      ];

    if (
      !bookingCode ||
      !config
    ) {
      return withCors(
        jsonError(
          "invalid_request"
        ),
        request
      );
    }

    const booking =
      await env.DB
        .prepare(`
          SELECT
            id,
            public_booking_code
          FROM bookings
          WHERE public_booking_code = ?
          LIMIT 1
        `)
        .bind(bookingCode)
        .first();

    if (!booking) {
      return withCors(
        jsonError(
          "booking_not_found",
          404
        ),
        request
      );
    }

    const delivery =
      await env.DB
        .prepare(`
          SELECT
            id,
            status,
            recipient_email
          FROM ${config.table}
          WHERE ${config.where}
          LIMIT 1
        `)
        .bind(booking.id)
        .first();

    if (!delivery) {
      return withCors(
        jsonError(
          "email_delivery_not_found",
          404
        ),
        request
      );
    }

    if (
      delivery.status !== "failed"
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error:
              "email_not_failed",
            current_status:
              delivery.status,
          },
          { status: 409 }
        ),
        request
      );
    }

    /*
     * failed → pending を条件付きで変更して
     * 二重クリック・同時実行を防ぐ。
     */
    const claimResult =
      await env.DB
        .prepare(`
          UPDATE ${config.table}
          SET
            status = 'pending',
            last_error = NULL,
            updated_at =
              CURRENT_TIMESTAMP
          WHERE id = ?
            AND status = 'failed'
        `)
        .bind(delivery.id)
        .run();

    if (
      Number(
        claimResult?.meta?.changes ||
        0
      ) !== 1
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error:
              "email_retry_in_progress",
          },
          { status: 409 }
        ),
        request
      );
    }

    const retryIdempotencyKey =
      `onv-manual-retry-${emailType}-${booking.id}-${crypto.randomUUID()}`;

    let result = "failed";

    try {
      if (
        emailType ===
        "booking_confirmation"
      ) {
        result =
          await sendBookingConfirmationEmail(
            env,
            booking.id,
            {
              idempotencyKey:
                retryIdempotencyKey,
            }
          );
      } else if (
        emailType ===
        "cancellation_completion"
      ) {
        result =
          await sendCancellationCompletionEmail(
            env,
            booking.id,
            {
              idempotencyKey:
                retryIdempotencyKey,
            }
          );
      } else if (
        emailType ===
        "admin_cancellation_notification"
      ) {
        result =
          await sendAdminCancellationNotificationEmail(
            env,
            booking.id,
            {
              idempotencyKey:
                retryIdempotencyKey,
            }
          );
      }
    } catch (sendError) {
      const errorMessage =
        String(
          sendError?.message ||
          "email_retry_error"
        ).slice(0, 500);

      await env.DB
        .prepare(`
          UPDATE ${config.table}
          SET
            status = 'failed',
            last_error = ?,
            updated_at =
              CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .bind(
          errorMessage,
          delivery.id
        )
        .run();

      console.error(
        "Admin email retry error:",
        sendError
      );

      return withCors(
        Response.json(
          {
            ok: false,
            error:
              "email_retry_failed",
          },
          { status: 502 }
        ),
        request
      );
    }

    if (result !== "sent") {
      if (
        result !== "failed"
      ) {
        await env.DB
          .prepare(`
            UPDATE ${config.table}
            SET
              status = 'failed',
              last_error = ?,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            `retry_result:${result}`,
            delivery.id
          )
          .run();
      }

      return withCors(
        Response.json(
          {
            ok: false,
            error:
              "email_retry_failed",
            result,
          },
          { status: 502 }
        ),
        request
      );
    }

    return withCors(
      Response.json({
        ok: true,

        booking_code:
          booking.public_booking_code,

        email_type:
          emailType,

        recipient_email:
          delivery.recipient_email,

        status:
          "sent",
      }),
      request
    );
  } catch (error) {
    console.error(
      "Admin email resend API error:",
      error
    );

    return withCors(
      jsonError(
        "internal_server_error",
        500
      ),
      request
    );
  }
}

/*
 * 管理者用：キャンセル・返金額プレビュー
 * このAPIではまだStripe返金を実行しない。
 */
if (
  url.pathname ===
    "/api/admin/cancellation-preview" &&
  request.method === "POST"
) {
  const authorization =
    request.headers.get("Authorization");

  const expectedAuthorization =
    `Bearer ${env.ADMIN_DASHBOARD_TOKEN}`;

  if (
    !env.ADMIN_DASHBOARD_TOKEN ||
    authorization !== expectedAuthorization
  ) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: "unauthorized",
        },
        { status: 401 }
      ),
      request
    );
  }

  try {
    const body = await request.json();

    const bookingCode =
      body.booking_code;

    const reasonCode =
      body.reason_code;

    const allowedReasons = new Set([
      "guest_request",
      "transport_cancellation",
      "facility_reason",
      "other",
    ]);

    if (
      !bookingCode ||
      !allowedReasons.has(reasonCode)
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "invalid_request",
          },
          { status: 400 }
        ),
        request
      );
    }

    const booking = await env.DB
      .prepare(`
        SELECT
          id,
          public_booking_code,
          check_in_date,
          check_out_date,
          guest_count,
          total_jpy,
          status,
          payment_status,
          customer_name
        FROM bookings
        WHERE public_booking_code = ?
        LIMIT 1
      `)
      .bind(bookingCode)
      .first();

    if (!booking) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "booking_not_found",
          },
          { status: 404 }
        ),
        request
      );
    }

    if (
      booking.status !== "confirmed" ||
      booking.payment_status !== "paid"
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error:
              "booking_not_cancellable",
            booking_status:
              booking.status,
            payment_status:
              booking.payment_status,
          },
          { status: 409 }
        ),
        request
      );
    }

    const policyRate =
      getCancellationPolicyRate(
        booking.check_in_date,
        reasonCode
      );

    const cancellationFeeJpy =
      Math.floor(
        booking.total_jpy *
          (policyRate / 100)
      );

    const refundAmountJpy =
      booking.total_jpy -
      cancellationFeeJpy;

    const today = getTokyoToday();

    const toUtc = (dateString) => {
      const [year, month, day] =
        dateString.split("-").map(Number);

      return Date.UTC(
        year,
        month - 1,
        day
      );
    };

    const daysUntilCheckIn =
      Math.floor(
        (
          toUtc(booking.check_in_date) -
          toUtc(today)
        ) /
          86400000
      );

    return withCors(
      Response.json({
        ok: true,

        booking: {
          booking_code:
            booking.public_booking_code,

          customer_name:
            booking.customer_name,

          check_in:
            booking.check_in_date,

          check_out:
            booking.check_out_date,

          guest_count:
            booking.guest_count,

          total_jpy:
            booking.total_jpy,
        },

        cancellation: {
          reason_code:
            reasonCode,

          days_until_check_in:
            daysUntilCheckIn,

          policy_rate:
            policyRate,

          cancellation_fee_jpy:
            cancellationFeeJpy,

          refund_amount_jpy:
            refundAmountJpy,
        },
      }),
      request
    );
  } catch (error) {
    console.error(
      "Cancellation preview API error:",
      error
    );

    return withCors(
      Response.json(
        {
          ok: false,
          error: "internal_server_error",
        },
        { status: 500 }
      ),
      request
    );
  }
}

/*
 * 管理者用：予約キャンセル・Stripe返金実行
 */
if (
  url.pathname === "/api/admin/cancel-refund" &&
  request.method === "POST"
) {
  const authorization =
    request.headers.get("Authorization");

  const expectedAuthorization =
    `Bearer ${env.ADMIN_DASHBOARD_TOKEN}`;

  if (
    !env.ADMIN_DASHBOARD_TOKEN ||
    authorization !== expectedAuthorization
  ) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: "unauthorized",
        },
        { status: 401 }
      ),
      request
    );
  }

  try {
    const body = await request.json();

    const bookingCode =
      body.booking_code;

    const reasonCode =
      body.reason_code;

    const adminNote =
      typeof body.admin_note === "string"
        ? body.admin_note.trim()
        : null;

    /*
     * 誤操作防止。
     * confirm:true がない限り実行しない。
     */
    if (body.confirm !== true) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "confirmation_required",
          },
          { status: 400 }
        ),
        request
      );
    }

    const allowedReasons = new Set([
      "guest_request",
      "transport_cancellation",
      "facility_reason",
      "other",
    ]);

    if (
      !bookingCode ||
      !allowedReasons.has(reasonCode)
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "invalid_request",
          },
          { status: 400 }
        ),
        request
      );
    }

    const booking = await env.DB
      .prepare(`
        SELECT
          id,
          public_booking_code,
          check_in_date,
          check_out_date,
          guest_count,
          total_jpy,
          status,
          payment_status,
          customer_name,
          customer_email,
          stripe_payment_intent_id
        FROM bookings
        WHERE public_booking_code = ?
        LIMIT 1
      `)
      .bind(bookingCode)
      .first();

    if (!booking) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "booking_not_found",
          },
          { status: 404 }
        ),
        request
      );
    }

    /*
     * 二重キャンセル防止
     */
    const existingCancellation =
      await env.DB
        .prepare(`
          SELECT
            id,
            reason_code,
            refund_amount_jpy,
            stripe_refund_id,
            stripe_refund_status
          FROM booking_cancellations
          WHERE booking_id = ?
          LIMIT 1
        `)
        .bind(booking.id)
        .first();

    if (
      existingCancellation &&
      (
        existingCancellation
          .stripe_refund_status ===
            "succeeded" ||
        existingCancellation
          .stripe_refund_status ===
            "not_required"
      )
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "already_cancelled",
          },
          { status: 409 }
        ),
        request
      );
    }

    if (
      booking.status !== "confirmed" ||
      booking.payment_status !== "paid"
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "booking_not_cancellable",
            booking_status:
              booking.status,
            payment_status:
              booking.payment_status,
          },
          { status: 409 }
        ),
        request
      );
    }

    if (
      !booking.stripe_payment_intent_id
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error:
              "stripe_payment_intent_missing",
          },
          { status: 409 }
        ),
        request
      );
    }

    /*
     * 金額はブラウザから受け取らず、
     * サーバー側で再計算する。
     */
    const policyRate =
      getCancellationPolicyRate(
        booking.check_in_date,
        reasonCode
      );

    const cancellationFeeJpy =
      Math.floor(
        booking.total_jpy *
          (policyRate / 100)
      );

    const refundAmountJpy =
      booking.total_jpy -
      cancellationFeeJpy;

    const cancellationId =
      existingCancellation?.id ??
      crypto.randomUUID();

    /*
     * まずキャンセル処理を pending として記録。
     */
    await env.DB
      .prepare(`
        INSERT INTO booking_cancellations (
          id,
          booking_id,
          reason_code,
          policy_rate,
          cancellation_fee_jpy,
          refund_amount_jpy,
          stripe_refund_status,
          admin_note
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)

        ON CONFLICT(booking_id)
        DO UPDATE SET
          reason_code = excluded.reason_code,
          policy_rate = excluded.policy_rate,
          cancellation_fee_jpy =
            excluded.cancellation_fee_jpy,
          refund_amount_jpy =
            excluded.refund_amount_jpy,
          stripe_refund_status =
            excluded.stripe_refund_status,
          admin_note = excluded.admin_note,
          updated_at = CURRENT_TIMESTAMP
      `)
      .bind(
        cancellationId,
        booking.id,
        reasonCode,
        policyRate,
        cancellationFeeJpy,
        refundAmountJpy,
        refundAmountJpy > 0
          ? "pending"
          : "not_required",
        adminNote
      )
      .run();

    let stripeRefundId = null;
    let stripeRefundStatus =
      refundAmountJpy > 0
        ? "pending"
        : "not_required";

    /*
     * 返金額が0円ならStripeには送らない。
     */
    if (refundAmountJpy > 0) {
      const stripeBody =
        new URLSearchParams();

      stripeBody.set(
        "payment_intent",
        booking.stripe_payment_intent_id
      );

      /*
       * JPYはゼロ小数通貨なので
       * ¥50,000 = amount 50000
       */
      stripeBody.set(
        "amount",
        String(refundAmountJpy)
      );

      const stripeResponse =
        await fetch(
          "https://api.stripe.com/v1/refunds",
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${env.STRIPE_SECRET_KEY}`,

              "Content-Type":
                "application/x-www-form-urlencoded",

              /*
               * 再送されても二重返金しない。
               */
              "Idempotency-Key":
                `booking-cancel-${booking.id}`,
            },

            body:
              stripeBody.toString(),
          }
        );

      const stripeRefund =
        await stripeResponse.json();

      if (!stripeResponse.ok) {
        console.error(
          "Stripe refund failed:",
          stripeRefund
        );

        await env.DB
          .prepare(`
            UPDATE booking_cancellations
            SET
              stripe_refund_status = 'failed',
              updated_at = CURRENT_TIMESTAMP
            WHERE booking_id = ?
          `)
          .bind(booking.id)
          .run();

        return withCors(
          Response.json(
            {
              ok: false,
              error: "stripe_refund_failed",
            },
            { status: 502 }
          ),
          request
        );
      }

      stripeRefundId =
        stripeRefund.id;

      stripeRefundStatus =
        stripeRefund.status === "succeeded"
          ? "succeeded"
          : "pending";
    }

    /*
     * payment_status
     *
     * 全額返金 → refunded
     * 一部返金 → partially_refunded
     * 返金なし → paidのまま
     * Stripe処理中 → paidのまま
     */
    let nextPaymentStatus =
      booking.payment_status;

    if (
      stripeRefundStatus === "succeeded"
    ) {
      nextPaymentStatus =
        refundAmountJpy ===
          booking.total_jpy
          ? "refunded"
          : "partially_refunded";
    }

    /*
     * 予約キャンセル・在庫解放・履歴確定
     */
    await env.DB.batch([
      env.DB
        .prepare(`
          UPDATE bookings
          SET
            status = 'cancelled',
            payment_status = ?,
            cancelled_at =
              CURRENT_TIMESTAMP,
            updated_at =
              CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .bind(
          nextPaymentStatus,
          booking.id
        ),

      env.DB
        .prepare(`
          DELETE FROM inventory_nights
          WHERE allocation_ref = ?
        `)
        .bind(booking.id),

      env.DB
        .prepare(`
          UPDATE booking_cancellations
          SET
            stripe_refund_id = ?,
            stripe_refund_status = ?,
            updated_at =
              CURRENT_TIMESTAMP
          WHERE booking_id = ?
        `)
        .bind(
          stripeRefundId,
          stripeRefundStatus,
          booking.id
        ),
    ]);

    /*
     * お客様へキャンセル・返金完了メール。
     *
     * 送信失敗でも、すでに完了した
     * Stripe返金・予約キャンセル・在庫解放は
     * 取り消さない。
     */
    let cancellationEmailStatus =
      "skipped";

    try {
      cancellationEmailStatus =
        await sendCancellationCompletionEmail(
          env,
          booking.id
        );
    } catch (emailError) {
      cancellationEmailStatus =
        "failed";

      console.error(
        "Cancellation completion email error:",
        emailError
      );
    }

    /*
     * 管理者へキャンセル・返金通知メール。
     *
     * 通知失敗でもキャンセル処理自体は
     * 成功のまま維持する。
     */
    let adminCancellationNotificationStatus =
      "skipped";

    try {
      adminCancellationNotificationStatus =
        await sendAdminCancellationNotificationEmail(
          env,
          booking.id
        );
    } catch (adminEmailError) {
      adminCancellationNotificationStatus =
        "failed";

      console.error(
        "Admin cancellation notification error:",
        adminEmailError
      );
    }

    return withCors(
      Response.json({
        ok: true,

        booking_code:
          booking.public_booking_code,

        status:
          "cancelled",

        payment_status:
          nextPaymentStatus,

        cancellation: {
          reason_code:
            reasonCode,

          policy_rate:
            policyRate,

          cancellation_fee_jpy:
            cancellationFeeJpy,

          refund_amount_jpy:
            refundAmountJpy,
        },

        stripe: {
          refund_id:
            stripeRefundId,

          refund_status:
            stripeRefundStatus,
        },

        cancellation_email:
          cancellationEmailStatus,

        admin_cancellation_notification:
          adminCancellationNotificationStatus,
      }),
      request
    );
  } catch (error) {
    console.error(
      "Cancel refund API error:",
      error
    );

    return withCors(
      Response.json(
        {
          ok: false,
          error:
            "internal_server_error",
        },
        { status: 500 }
      ),
      request
    );
  }
}

  return null;
}
