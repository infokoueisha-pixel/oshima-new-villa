import { HOLD_MINUTES } from "../config.js";
import { isValidDate, getStayDates, toSqlUtc, getTokyoToday, getCancellationPolicyRate } from "../lib/dates.js";
import { withCors, jsonError } from "../lib/http.js";
import { sendCancellationCompletionEmail, sendAdminCancellationNotificationEmail } from "../services/emails.js";
import { createPublicBookingCode, sha256, createFingerprint, getAvailability, getBookingByIdempotencyKey, existingBookingResponse } from "../services/booking.js";

export async function handleWebhookRoutes(request, env, url) {
/*
 * Stripe Webhook
 * 決済完了 → 予約確定
 */
if (
  url.pathname === "/api/stripe/webhook" &&
  request.method === "POST"
) {
  try {
    /*
     * 重要：
     * Stripe署名はJSON化する前の
     * 生のBodyで検証する
     */
    const rawBody = await request.text();

    const stripeSignature =
      request.headers.get("Stripe-Signature");

    if (!stripeSignature) {
      return Response.json(
        {
          ok: false,
          error: "stripe_signature_missing",
        },
        { status: 400 }
      );
    }

    /*
     * Stripe-Signatureを解析
     *
     * 例：
     * t=1234567890,v1=xxxxxx
     */
    const signatureParts =
      stripeSignature.split(",");

    let timestamp = null;
    const signatures = [];

    for (const part of signatureParts) {
      const [key, value] =
        part.split("=");

      if (key === "t") {
        timestamp = value;
      }

      if (key === "v1") {
        signatures.push(value);
      }
    }

    if (
      !timestamp ||
      signatures.length === 0
    ) {
      return Response.json(
        {
          ok: false,
          error: "invalid_stripe_signature",
        },
        { status: 400 }
      );
    }

    /*
     * 古すぎるWebhookを拒否
     * 許容：5分
     */
    const timestampNumber =
      Number(timestamp);

    const nowSeconds =
      Math.floor(Date.now() / 1000);

    if (
      !Number.isFinite(timestampNumber) ||
      Math.abs(
        nowSeconds - timestampNumber
      ) > 300
    ) {
      return Response.json(
        {
          ok: false,
          error: "stripe_signature_expired",
        },
        { status: 400 }
      );
    }

    /*
     * Stripe仕様：
     * HMAC-SHA256(
     *   webhook_secret,
     *   timestamp + "." + raw_body
     * )
     */
    const signedPayload =
      `${timestamp}.${rawBody}`;

    const cryptoKey =
      await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(
          env.STRIPE_WEBHOOK_SECRET
        ),
        {
          name: "HMAC",
          hash: "SHA-256",
        },
        false,
        ["sign"]
      );

    const signatureBuffer =
      await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        new TextEncoder().encode(
          signedPayload
        )
      );

    const expectedSignature =
      [...new Uint8Array(signatureBuffer)]
        .map((byte) =>
          byte
            .toString(16)
            .padStart(2, "0")
        )
        .join("");

    /*
     * タイミング差を小さくする比較
     */
    function constantTimeEqual(a, b) {
      if (a.length !== b.length) {
        return false;
      }

      let difference = 0;

      for (
        let i = 0;
        i < a.length;
        i++
      ) {
        difference |=
          a.charCodeAt(i) ^
          b.charCodeAt(i);
      }

      return difference === 0;
    }

    const signatureValid =
      signatures.some((signature) =>
        constantTimeEqual(
          signature,
          expectedSignature
        )
      );

    if (!signatureValid) {
      console.error(
        "Stripe webhook signature verification failed"
      );

      return Response.json(
        {
          ok: false,
          error:
            "stripe_signature_verification_failed",
        },
        { status: 400 }
      );
    }

    /*
     * 署名検証後に初めてJSON化
     */
    let event;

    try {
      event = JSON.parse(rawBody);
    } catch {
      return Response.json(
        {
          ok: false,
          error: "invalid_webhook_json",
        },
        { status: 400 }
      );
    }

    /*
     * 同じStripeイベントを
     * すでに処理済みなら即終了
     */
    const existingEvent =
      await env.DB
        .prepare(`
          SELECT stripe_event_id
          FROM stripe_webhook_events
          WHERE stripe_event_id = ?
          LIMIT 1
        `)
        .bind(event.id)
        .first();

    if (existingEvent) {
      return Response.json({
        ok: true,
        already_processed: true,
      });
    }

    /*
     * 今は
     * checkout.session.completed
     * だけ処理
     */
    if (
      event.type !==
      "checkout.session.completed"
    ) {
      await env.DB
        .prepare(`
          INSERT INTO stripe_webhook_events (
            stripe_event_id,
            event_type,
            booking_id,
            status
          ) VALUES (?, ?, NULL, 'ignored')
        `)
        .bind(
          event.id,
          event.type
        )
        .run();

      return Response.json({
        ok: true,
        ignored: true,
      });
    }

    const session =
      event.data?.object;

    if (!session) {
      return Response.json(
        {
          ok: false,
          error:
            "stripe_session_missing",
        },
        { status: 400 }
      );
    }

    /*
     * 支払済みであることを確認
     */
    if (
      session.payment_status !== "paid"
    ) {
      await env.DB
        .prepare(`
          INSERT INTO stripe_webhook_events (
            stripe_event_id,
            event_type,
            booking_id,
            status
          ) VALUES (?, ?, ?, 'ignored')
        `)
        .bind(
          event.id,
          event.type,
          session.client_reference_id ||
            null
        )
        .run();

      return Response.json({
        ok: true,
        ignored: true,
        reason: "payment_not_paid",
      });
    }

    const bookingId =
      session.client_reference_id;

    if (!bookingId) {
      return Response.json(
        {
          ok: false,
          error:
            "booking_reference_missing",
        },
        { status: 400 }
      );
    }

    /*
     * 大島ニュービラ側の
     * 予約を取得
     */
    const booking =
      await env.DB
        .prepare(`
          SELECT
            id,
            public_booking_code,
            total_jpy,
            status,
            payment_status,
            stripe_checkout_session_id
          FROM bookings
          WHERE id = ?
          LIMIT 1
        `)
        .bind(bookingId)
        .first();

    if (!booking) {
      console.error(
        "Webhook booking not found:",
        bookingId
      );

      return Response.json(
        {
          ok: false,
          error: "booking_not_found",
        },
        { status: 404 }
      );
    }

    /*
     * Stripe Session ID照合
     */
    if (
      booking.stripe_checkout_session_id !==
      session.id
    ) {
      console.error(
        "Checkout Session mismatch"
      );

      return Response.json(
        {
          ok: false,
          error:
            "checkout_session_mismatch",
        },
        { status: 400 }
      );
    }

    /*
     * 金額照合
     *
     * JPYはStripeでも
     * 105000 = ¥105,000
     */
    if (
      Number(session.amount_total) !==
      Number(booking.total_jpy)
    ) {
      console.error(
        "Payment amount mismatch"
      );

      return Response.json(
        {
          ok: false,
          error:
            "payment_amount_mismatch",
        },
        { status: 400 }
      );
    }

    /*
     * 通貨照合
     */
    if (
      String(session.currency)
        .toLowerCase() !== "jpy"
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "payment_currency_mismatch",
        },
        { status: 400 }
      );
    }

    /*
     * 最終確定処理
     *
     * 予約：
     * pending_payment → confirmed
     *
     * 決済：
     * unpaid → paid
     *
     * 在庫：
     * hold → booking
     *
     * Webhookイベント：
     * processed として保存
     */
    try {
      await env.DB.batch([
        env.DB
          .prepare(`
            INSERT INTO stripe_webhook_events (
              stripe_event_id,
              event_type,
              booking_id,
              status
            ) VALUES (?, ?, ?, 'processed')
          `)
          .bind(
            event.id,
            event.type,
            booking.id
          ),

        env.DB
          .prepare(`
            UPDATE bookings
            SET
              status = 'confirmed',
              payment_status = 'paid',
              stripe_payment_intent_id = ?,
              confirmed_at =
                CURRENT_TIMESTAMP,
              hold_expires_at = NULL,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE id = ?
              AND status =
                'pending_payment'
              AND payment_status =
                'unpaid'
          `)
          .bind(
            session.payment_intent ||
              null,
            booking.id
          ),

        env.DB
          .prepare(`
            UPDATE inventory_nights
            SET
              allocation_type =
                'booking',
              expires_at = NULL,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE allocation_ref = ?
              AND allocation_type =
                'hold'
          `)
          .bind(booking.id),
      ]);
    } catch (error) {
      /*
       * Stripeが同じイベントを
       * 同時再送した場合など
       */
      const processedEvent =
        await env.DB
          .prepare(`
            SELECT stripe_event_id
            FROM stripe_webhook_events
            WHERE stripe_event_id = ?
            LIMIT 1
          `)
          .bind(event.id)
          .first();

      if (processedEvent) {
        return Response.json({
          ok: true,
          already_processed: true,
        });
      }

      throw error;
    }

/*
 * お客様へ予約確定メール
 *
 * メール送信に失敗しても
 * 予約そのものは confirmed / paid のまま維持する
 */
let bookingConfirmationEmailStatus =
  "skipped";

try {
  const emailBooking =
    await env.DB
      .prepare(`
        SELECT
          b.id,
          b.public_booking_code,
          b.customer_name,
          b.customer_email,
          b.check_in_date,
          b.check_out_date,
          b.guest_count,
          b.total_jpy,
          b.cancellation_policy_snapshot,
          p.name AS product_name

        FROM bookings b

        JOIN products p
          ON p.id = b.product_id

        WHERE b.id = ?
        LIMIT 1
      `)
      .bind(booking.id)
      .first();

  if (emailBooking?.customer_email) {
    /*
     * すでに送信済みか確認
     */
    const existingDelivery =
      await env.DB
        .prepare(`
          SELECT
            id,
            status
          FROM email_deliveries
          WHERE booking_id = ?
            AND email_type =
              'booking_confirmation'
          LIMIT 1
        `)
        .bind(booking.id)
        .first();

    if (
      existingDelivery?.status ===
      "sent"
    ) {
      bookingConfirmationEmailStatus =
        "already_sent";
    } else {
      const deliveryId =
        existingDelivery?.id ||
        crypto.randomUUID();

      /*
       * 先に送信予定をDBへ記録
       */
      if (!existingDelivery) {
        await env.DB
          .prepare(`
            INSERT INTO email_deliveries (
              id,
              booking_id,
              email_type,
              recipient_email,
              status
            )
            VALUES (
              ?,
              ?,
              'booking_confirmation',
              ?,
              'pending'
            )
          `)
          .bind(
            deliveryId,
            booking.id,
            emailBooking.customer_email
          )
          .run();
      }

      const escapeHtml = (value) =>
        String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");

      const checkInTime =
        Date.parse(
          `${emailBooking.check_in_date}T00:00:00Z`
        );

      const checkOutTime =
        Date.parse(
          `${emailBooking.check_out_date}T00:00:00Z`
        );

      const nights =
        Math.max(
          1,
          Math.round(
            (
              checkOutTime -
              checkInTime
            ) /
              86400000
          )
        );

      const formattedAmount =
        Number(
          emailBooking.total_jpy
        ).toLocaleString("ja-JP");

      const policyText =
        emailBooking
          .cancellation_policy_snapshot ||
        "";

      const policyHtml =
        escapeHtml(policyText)
          .replace(/\n/g, "<br>");

      const subject =
        `【大島ニュービラ】ご予約が確定しました｜${emailBooking.public_booking_code}`;

      const textBody = `
${emailBooking.customer_name} 様

大島ニュービラをご予約いただき、ありがとうございます。
以下の内容でご予約が確定しました。

■ 予約番号
${emailBooking.public_booking_code}

■ 宿泊施設
${emailBooking.product_name}

■ チェックイン
${emailBooking.check_in_date}

■ チェックアウト
${emailBooking.check_out_date}

■ 泊数
${nights}泊

■ 宿泊人数
${emailBooking.guest_count}名

■ お支払い済み金額
¥${formattedAmount}

お支払いは完了しています。

■ キャンセルポリシー
${policyText}

チェックイン方法・アクセス・ご宿泊にあたっての重要事項は、
ご宿泊前に改めてご案内いたします。

大島ニュービラ
https://oshima-new-villa.com/

※このメールは自社予約システムより自動送信されています。
      `.trim();

      const htmlBody = `
<div style="
  max-width:640px;
  margin:0 auto;
  font-family:
    Arial,
    'Hiragino Kaku Gothic ProN',
    'Yu Gothic',
    sans-serif;
  color:#222;
  line-height:1.8;
">

  <h2 style="margin-bottom:8px;">
    大島ニュービラ
  </h2>

  <p>
    ${escapeHtml(
      emailBooking.customer_name
    )} 様
  </p>

  <p>
    この度は大島ニュービラをご予約いただき、
    ありがとうございます。<br>
    以下の内容で
    <strong>ご予約が確定しました。</strong>
  </p>

  <div style="
    background:#f7f7f7;
    padding:20px;
    margin:24px 0;
    border-radius:8px;
  ">

    <p>
      <strong>予約番号</strong><br>
      ${escapeHtml(
        emailBooking.public_booking_code
      )}
    </p>

    <p>
      <strong>宿泊施設</strong><br>
      ${escapeHtml(
        emailBooking.product_name
      )}
    </p>

    <p>
      <strong>チェックイン</strong><br>
      ${escapeHtml(
        emailBooking.check_in_date
      )}
    </p>

    <p>
      <strong>チェックアウト</strong><br>
      ${escapeHtml(
        emailBooking.check_out_date
      )}
    </p>

    <p>
      <strong>泊数</strong><br>
      ${nights}泊
    </p>

    <p>
      <strong>宿泊人数</strong><br>
      ${emailBooking.guest_count}名
    </p>

    <p>
      <strong>お支払い済み金額</strong><br>
      <span style="
        font-size:22px;
        font-weight:bold;
      ">
        ¥${formattedAmount}
      </span>
    </p>

    <p style="margin-bottom:0;">
      ✓ お支払いは完了しています。
    </p>

  </div>

  <h3>キャンセルポリシー</h3>

  <p style="font-size:14px;">
    ${policyHtml}
  </p>

  <hr style="
    border:0;
    border-top:1px solid #ddd;
    margin:28px 0;
  ">

  <p>
    チェックイン方法・アクセス・
    ご宿泊にあたっての重要事項は、
    ご宿泊前に改めてご案内いたします。
  </p>

  <p>
    <a href="https://oshima-new-villa.com/">
      大島ニュービラ公式サイト
    </a>
  </p>

  <p style="
    margin-top:32px;
    font-size:13px;
    color:#666;
  ">
    ※このメールは大島ニュービラ
    自社予約システムより
    自動送信されています。
  </p>

</div>
      `.trim();

      /*
       * Resendで送信
       */
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

              /*
               * 同じ予約の確認メールを
               * 二重送信しない
               */
              "Idempotency-Key":
                `onv-booking-confirmation-${booking.id}`,
            },

            body: JSON.stringify({
              from:
                "大島ニュービラ <booking@oshima-new-villa.com>",

              to: [
                emailBooking.customer_email,
              ],

              subject,

              text: textBody,

              html: htmlBody,
            }),
          }
        );

      if (resendResponse.ok) {
        const resendResult =
          await resendResponse.json();

        await env.DB
          .prepare(`
            UPDATE email_deliveries
            SET
              resend_email_id = ?,
              status = 'sent',
              last_error = NULL,
              sent_at =
                CURRENT_TIMESTAMP,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            resendResult.id,
            deliveryId
          )
          .run();

        bookingConfirmationEmailStatus =
          "sent";
      } else {
        const resendError =
          await resendResponse.json();

        const errorMessage =
          String(
            resendError?.message ||
            resendError?.name ||
            "resend_error"
          ).slice(0, 500);

        await env.DB
          .prepare(`
            UPDATE email_deliveries
            SET
              status = 'failed',
              last_error = ?,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            errorMessage,
            deliveryId
          )
          .run();

        bookingConfirmationEmailStatus =
          "failed";

        console.error(
          "Booking confirmation email failed:",
          errorMessage
        );
      }
    }
  }
} catch (emailError) {
  /*
   * メール障害では
   * Stripe Webhookを失敗扱いにしない
   */
  bookingConfirmationEmailStatus =
    "failed";

  console.error(
    "Booking confirmation email error:",
    emailError
  );
}

/*
 * 管理者へ新規予約通知メール
 *
 * 通知失敗でも予約・決済は
 * confirmed / paid のまま維持する
 */
let adminBookingNotificationStatus =
  "skipped";

try {
  const adminEmail =
    String(
      env.ADMIN_NOTIFICATION_EMAIL || ""
    ).trim();

  if (adminEmail) {
    const adminBooking =
      await env.DB
        .prepare(`
          SELECT
            b.id,
            b.public_booking_code,

            b.customer_name,
            b.customer_email,
            b.customer_phone,

            b.check_in_date,
            b.check_out_date,

            b.guest_count,
            b.total_jpy,

            p.name AS product_name

          FROM bookings b

          JOIN products p
            ON p.id = b.product_id

          WHERE b.id = ?
          LIMIT 1
        `)
        .bind(booking.id)
        .first();

    if (adminBooking) {
      /*
       * すでに管理者通知を
       * 送信済みか確認
       */
      const existingAdminDelivery =
        await env.DB
          .prepare(`
            SELECT
              id,
              status
            FROM email_deliveries
            WHERE booking_id = ?
              AND email_type =
                'admin_booking_notification'
            LIMIT 1
          `)
          .bind(booking.id)
          .first();

      if (
        existingAdminDelivery?.status ===
        "sent"
      ) {
        adminBookingNotificationStatus =
          "already_sent";
      } else {
        const deliveryId =
          existingAdminDelivery?.id ||
          crypto.randomUUID();

        if (!existingAdminDelivery) {
          await env.DB
            .prepare(`
              INSERT INTO email_deliveries (
                id,
                booking_id,
                email_type,
                recipient_email,
                status
              )
              VALUES (
                ?,
                ?,
                'admin_booking_notification',
                ?,
                'pending'
              )
            `)
            .bind(
              deliveryId,
              booking.id,
              adminEmail
            )
            .run();
        }

        /*
         * 泊数計算
         */
        const checkInTime =
          Date.parse(
            `${adminBooking.check_in_date}T00:00:00Z`
          );

        const checkOutTime =
          Date.parse(
            `${adminBooking.check_out_date}T00:00:00Z`
          );

        const nights =
          Math.max(
            1,
            Math.round(
              (
                checkOutTime -
                checkInTime
              ) /
                86400000
            )
          );

        const formattedAmount =
          Number(
            adminBooking.total_jpy
          ).toLocaleString("ja-JP");

        const escapeHtml = (value) =>
          String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll(
              "'",
              "&#039;"
            );

        const subject =
          `【新規予約】${adminBooking.product_name}｜${adminBooking.check_in_date}〜${adminBooking.check_out_date}｜${adminBooking.guest_count}名｜¥${formattedAmount}`;

        const textBody = `
大島ニュービラに新しい予約が入りました。

■ 予約番号
${adminBooking.public_booking_code}

■ 宿泊施設
${adminBooking.product_name}

■ チェックイン
${adminBooking.check_in_date}

■ チェックアウト
${adminBooking.check_out_date}

■ 泊数
${nights}泊

■ 宿泊人数
${adminBooking.guest_count}名

■ 売上
¥${formattedAmount}

■ 決済
支払済み

■ 予約者名
${adminBooking.customer_name}

■ メールアドレス
${adminBooking.customer_email}

■ 電話番号
${adminBooking.customer_phone || "未登録"}

Stripe決済および予約確定処理は完了しています。

大島ニュービラ 自社予約システム
        `.trim();

        const htmlBody = `
<div style="
  max-width:640px;
  margin:0 auto;
  font-family:
    Arial,
    'Hiragino Kaku Gothic ProN',
    'Yu Gothic',
    sans-serif;
  color:#222;
  line-height:1.7;
">

  <h2>
    新規予約が入りました
  </h2>

  <div style="
    background:#f7f7f7;
    padding:20px;
    border-radius:8px;
    margin:20px 0;
  ">

    <p>
      <strong>予約番号</strong><br>
      ${escapeHtml(
        adminBooking.public_booking_code
      )}
    </p>

    <p>
      <strong>宿泊施設</strong><br>
      ${escapeHtml(
        adminBooking.product_name
      )}
    </p>

    <p>
      <strong>宿泊日</strong><br>
      ${escapeHtml(
        adminBooking.check_in_date
      )}
      ～
      ${escapeHtml(
        adminBooking.check_out_date
      )}
      （${nights}泊）
    </p>

    <p>
      <strong>宿泊人数</strong><br>
      ${adminBooking.guest_count}名
    </p>

    <p>
      <strong>売上</strong><br>
      <span style="
        font-size:22px;
        font-weight:bold;
      ">
        ¥${formattedAmount}
      </span>
    </p>

    <p>
      <strong>決済状況</strong><br>
      ✓ 支払済み
    </p>

  </div>

  <h3>予約者情報</h3>

  <p>
    <strong>氏名</strong><br>
    ${escapeHtml(
      adminBooking.customer_name
    )}
  </p>

  <p>
    <strong>メール</strong><br>
    ${escapeHtml(
      adminBooking.customer_email
    )}
  </p>

  <p>
    <strong>電話番号</strong><br>
    ${escapeHtml(
      adminBooking.customer_phone ||
        "未登録"
    )}
  </p>

  <hr style="
    border:0;
    border-top:1px solid #ddd;
    margin:28px 0;
  ">

  <p style="
    font-size:13px;
    color:#666;
  ">
    Stripe決済および
    大島ニュービラ自社予約システムの
    予約確定処理は完了しています。
  </p>

</div>
        `.trim();

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
                  `onv-admin-booking-${booking.id}`,
              },

              body: JSON.stringify({
                from:
                  "大島ニュービラ予約システム <booking@oshima-new-villa.com>",

                to: [
                  adminEmail,
                ],

                subject,

                text: textBody,

                html: htmlBody,
              }),
            }
          );

        if (resendResponse.ok) {
          const resendResult =
            await resendResponse.json();

          await env.DB
            .prepare(`
              UPDATE email_deliveries
              SET
                resend_email_id = ?,
                status = 'sent',
                last_error = NULL,
                sent_at =
                  CURRENT_TIMESTAMP,
                updated_at =
                  CURRENT_TIMESTAMP
              WHERE id = ?
            `)
            .bind(
              resendResult.id,
              deliveryId
            )
            .run();

          adminBookingNotificationStatus =
            "sent";
        } else {
          const resendError =
            await resendResponse.json();

          const errorMessage =
            String(
              resendError?.message ||
              resendError?.name ||
              "resend_error"
            ).slice(0, 500);

          await env.DB
            .prepare(`
              UPDATE email_deliveries
              SET
                status = 'failed',
                last_error = ?,
                updated_at =
                  CURRENT_TIMESTAMP
              WHERE id = ?
            `)
            .bind(
              errorMessage,
              deliveryId
            )
            .run();

          adminBookingNotificationStatus =
            "failed";

          console.error(
            "Admin booking notification failed:",
            errorMessage
          );
        }
      }
    }
  }
} catch (adminEmailError) {
  /*
   * 管理者メール障害でも
   * 予約・決済は成功扱い
   */
  adminBookingNotificationStatus =
    "failed";

  console.error(
    "Admin booking notification error:",
    adminEmailError
  );
}

    return Response.json({
  ok: true,

  booking_code:
    booking.public_booking_code,

  booking_status:
    "confirmed",

  payment_status:
    "paid",

  booking_confirmation_email:
    bookingConfirmationEmailStatus,

  admin_booking_notification:
    adminBookingNotificationStatus,
});
  } catch (error) {
    console.error(
      "Stripe webhook error:",
      error
    );

    return Response.json(
      {
        ok: false,
        error:
          "stripe_webhook_internal_error",
      },
      { status: 500 }
    );
  }
}

  return null;
}
