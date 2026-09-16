import { HOLD_MINUTES } from "../config.js";
import { isValidDate, getStayDates, toSqlUtc, getTokyoToday, getCancellationPolicyRate } from "../lib/dates.js";
import { withCors, jsonError } from "../lib/http.js";
import { sendCancellationCompletionEmail, sendAdminCancellationNotificationEmail } from "../services/emails.js";
import { createPublicBookingCode, sha256, createFingerprint, getAvailability, getBookingByIdempotencyKey, existingBookingResponse } from "../services/booking.js";

export async function handlePublicRoutes(request, env, url) {
/*
 * 公開用：決済中断後の予約状態確認
 *
 * booking_code を受け取り、
 * 再決済できる状態かどうかだけを返す。
 * 個人情報・金額・Stripe URLは返さない。
 */
if (
  url.pathname === "/api/booking-payment-status" &&
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

    const bookingCode =
      String(body.booking_code || "").trim();

    if (
      !bookingCode ||
      !/^ONV-[A-Z0-9]{10}$/.test(bookingCode)
    ) {
      return withCors(
        jsonError(
          "invalid_booking_code",
          400
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
            hold_expires_at
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

    if (
      booking.status === "confirmed" &&
      booking.payment_status === "paid"
    ) {
      return withCors(
        Response.json({
          ok: true,
          state: "confirmed",
        }),
        request
      );
    }

    if (booking.status === "cancelled") {
      return withCors(
        Response.json({
          ok: true,
          state: "cancelled",
        }),
        request
      );
    }

    if (booking.status === "expired") {
      return withCors(
        Response.json({
          ok: true,
          state: "expired",
        }),
        request
      );
    }

    if (
      booking.status === "pending_payment" &&
      booking.payment_status === "unpaid"
    ) {
      if (!booking.hold_expires_at) {
        return withCors(
          Response.json({
            ok: true,
            state: "expired",
          }),
          request
        );
      }

      const holdExpiresAt =
        new Date(
          booking.hold_expires_at
            .replace(" ", "T") + "Z"
        );

      if (
        Number.isNaN(
          holdExpiresAt.getTime()
        ) ||
        holdExpiresAt.getTime() <= Date.now()
      ) {
        return withCors(
          Response.json({
            ok: true,
            state: "expired",
          }),
          request
        );
      }

      return withCors(
        Response.json({
          ok: true,
          state: "retryable",
          hold_expires_at:
            booking.hold_expires_at,
        }),
        request
      );
    }

    return withCors(
      Response.json({
        ok: true,
        state: "not_payable",
      }),
      request
    );
  } catch (error) {
    console.error(
      "Booking payment status API error:",
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
 * 公開用：決済完了後の予約確定確認
 *
 * Stripe Checkout の session_id を
 * ブラウザから受け取り、
 * D1上で confirmed / paid になった予約だけ
 * 予約詳細を返す。
 *
 * session_id はURLクエリではなく
 * POST bodyで受け取る。
 */
if (
  url.pathname === "/api/booking-confirmation" &&
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

    const sessionId =
      String(body.session_id || "").trim();

    if (
      !sessionId ||
      !sessionId.startsWith("cs_") ||
      sessionId.length > 255
    ) {
      return withCors(
        jsonError(
          "invalid_checkout_session_id",
          400
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
            b.total_jpy,

            b.status,
            b.payment_status,

            b.customer_email,
            b.confirmed_at,
            b.cancelled_at

          FROM bookings b

          JOIN products p
            ON p.id = b.product_id

          WHERE
            b.stripe_checkout_session_id = ?
          LIMIT 1
        `)
        .bind(sessionId)
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

    if (booking.status === "cancelled") {
      return withCors(
        Response.json({
          ok: true,
          state: "cancelled",
          booking_code:
            booking.public_booking_code,
        }),
        request
      );
    }

    if (
      booking.status ===
        "pending_payment" &&
      booking.payment_status === "unpaid"
    ) {
      return withCors(
        Response.json({
          ok: true,
          state: "processing",
        }),
        request
      );
    }

    if (
      booking.status === "confirmed" &&
      booking.payment_status === "paid"
    ) {
      return withCors(
        Response.json({
          ok: true,
          state: "confirmed",

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

            total_jpy:
              booking.total_jpy,

            customer_email:
              booking.customer_email,

            confirmed_at:
              booking.confirmed_at,
          },
        }),
        request
      );
    }

    return withCors(
      Response.json({
        ok: true,
        state: "not_confirmed",
      }),
      request
    );
  } catch (error) {
    console.error(
      "Booking confirmation API error:",
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
 * Resend メール送信テスト
 * 開発完了後に削除する
 */
if (
  url.pathname === "/api/email-test" &&
  request.method === "POST"
) {
  try {
    /*
     * テストAPIの不正利用防止
     */
    const testToken =
      request.headers.get(
        "X-Email-Test-Token"
      );

    if (
      !env.EMAIL_TEST_SECRET ||
      testToken !==
        env.EMAIL_TEST_SECRET
    ) {
      return Response.json(
        {
          ok: false,
          error: "unauthorized",
        },
        { status: 401 }
      );
    }

    /*
     * 送信先取得
     */
    let body;

    try {
      body = await request.json();
    } catch {
      return Response.json(
        {
          ok: false,
          error: "invalid_json",
        },
        { status: 400 }
      );
    }

    const to =
      String(body.to || "")
        .trim()
        .toLowerCase();

    if (
      !to ||
      to.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/
        .test(to)
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "invalid_email_address",
        },
        { status: 400 }
      );
    }

    /*
     * 同じテスト操作の
     * 二重送信防止
     */
    const recipientHash =
      await sha256(to);

    const resendResponse =
      await fetch(
        "https://api.resend.com/emails",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${env.RESEND_API_KEY}`,

            "Content-Type":
              "application/json",

            "Idempotency-Key":
              `onv-email-test-${recipientHash.slice(
                0,
                24
              )}`,
          },

          body: JSON.stringify({
            from:
              "大島ニュービラ <booking@oshima-new-villa.com>",

            to: [to],

            subject:
              "【大島ニュービラ】メール送信テスト",

            text:
              "大島ニュービラ自社予約システムからのメール送信テストです。正常に受信できています。",

            html: `
              <div style="font-family: Arial, 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif; line-height: 1.8; color: #222;">
                <h2>大島ニュービラ</h2>

                <p>
                  自社予約システムからの
                  メール送信テストです。
                </p>

                <p>
                  このメールを受信できていれば、
                  Cloudflare Worker から Resend を経由した
                  メール送信は正常に動作しています。
                </p>

                <hr style="border:0;border-top:1px solid #ddd;margin:24px 0;">

                <p style="font-size:13px;color:#666;">
                  ※これは開発環境から送信されたテストメールです。
                </p>
              </div>
            `,
          }),
        }
      );

    if (!resendResponse.ok) {
      const resendError =
        await resendResponse.json();

      console.error(
        "Resend email test failed:",
        resendResponse.status,
        resendError?.name ||
          resendError?.message ||
          "unknown_error"
      );

      return Response.json(
        {
          ok: false,
          error:
            "email_send_failed",
        },
        { status: 502 }
      );
    }

    const resendResult =
      await resendResponse.json();

    return Response.json({
      ok: true,
      email_sent: true,
      resend_email_id:
        resendResult.id,
    });
  } catch (error) {
    console.error(
      "Email test error:",
      error
    );

    return Response.json(
      {
        ok: false,
        error:
          "email_test_internal_error",
      },
      { status: 500 }
    );
  }
}

/*
 * Stripeテスト用
 * Checkout成功後の遷移先
 */
if (
  url.pathname === "/checkout/success" &&
  request.method === "GET"
) {
  return Response.json({
    ok: true,
    message:
      "決済完了画面です。現在は開発環境です。",
  });
}

/*
 * Stripeテスト用
 * Checkoutキャンセル時の遷移先
 */
if (
  url.pathname === "/checkout/cancel" &&
  request.method === "GET"
) {
  return Response.json({
    ok: true,
    message:
      "決済は完了していません。現在は開発環境です。",
  });
}

  return null;
}
