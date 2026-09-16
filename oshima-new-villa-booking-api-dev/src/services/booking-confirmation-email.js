import { escapeEmailHtml } from "../lib/format.js";

/*
 * お客様へ予約確定メールを送信する。
 *
 * 既存のWebhook送信と同じ内容を使う。
 * 手動再送時は options.idempotencyKey に
 * 新しいキーを渡してResendへ再送する。
 */
async function sendBookingConfirmationEmail(
  env,
  bookingId,
  options = {}
) {
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
      .bind(bookingId)
      .first();

  if (!emailBooking?.customer_email) {
    return "skipped";
  }

  const existingDelivery =
    await env.DB
      .prepare(`
        SELECT
          id,
          status
        FROM email_deliveries
        WHERE booking_id = ?
          AND email_type = 'booking_confirmation'
        LIMIT 1
      `)
      .bind(bookingId)
      .first();

  if (existingDelivery?.status === "sent") {
    return "already_sent";
  }

  const deliveryId =
    existingDelivery?.id ||
    crypto.randomUUID();

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
        bookingId,
        emailBooking.customer_email
      )
      .run();
  } else {
    await env.DB
      .prepare(`
        UPDATE email_deliveries
        SET
          recipient_email = ?,
          status = 'pending',
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(
        emailBooking.customer_email,
        deliveryId
      )
      .run();
  }

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
        (checkOutTime - checkInTime) /
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
    escapeEmailHtml(policyText)
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
    ${escapeEmailHtml(
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
      ${escapeEmailHtml(
        emailBooking.public_booking_code
      )}
    </p>

    <p>
      <strong>宿泊施設</strong><br>
      ${escapeEmailHtml(
        emailBooking.product_name
      )}
    </p>

    <p>
      <strong>チェックイン</strong><br>
      ${escapeEmailHtml(
        emailBooking.check_in_date
      )}
    </p>

    <p>
      <strong>チェックアウト</strong><br>
      ${escapeEmailHtml(
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

  const idempotencyKey =
    options.idempotencyKey ||
    `onv-booking-confirmation-${bookingId}`;

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
            idempotencyKey,
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
          sent_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(
        resendResult.id,
        deliveryId
      )
      .run();

    return "sent";
  }

  const resendError =
    await resendResponse.json()
      .catch(() => null);

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
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .bind(
      errorMessage,
      deliveryId
    )
    .run();

  console.error(
    "Booking confirmation email failed:",
    errorMessage
  );

  return "failed";
}

export {
  sendBookingConfirmationEmail,
};
