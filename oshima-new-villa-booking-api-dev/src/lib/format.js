function getCancellationReasonLabel(
  reasonCode
) {
  const labels = {
    guest_request: "お客様都合",
    transport_cancellation:
      "船・航空便の正式欠航",
    facility_reason: "施設都合",
    other: "その他",
  };

  return labels[reasonCode] || "その他";
}

function escapeEmailHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export { getCancellationReasonLabel, escapeEmailHtml };
