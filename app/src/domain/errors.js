// The only error type thrown by domain services. Routes map this to HTTP; the AI layer
// returns it to the model verbatim as a tool_result with is_error=true.
class DomainError extends Error {
  // code: "FORBIDDEN" | "NOT_FOUND" | "INVALID" | "LATE" | "LIMIT" | "CONFLICT" | "UNAVAILABLE"
  // fieldErrors: optional { field: "mesaj RO" } map, used by public forms (design-formular-date.md)
  // to show inline errors next to the right input instead of a single generic message.
  constructor(code, messageRo, article = null, fieldErrors = null) {
    super(messageRo);
    this.name = "DomainError";
    this.code = code;
    this.article = article;
    this.fieldErrors = fieldErrors;
  }
}

const STATUS_BY_CODE = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID: 400,
  LATE: 409,
  CONFLICT: 409,
  LIMIT: 429,
  UNAVAILABLE: 503, // an external dependency (WhatsApp gateway) failed
};

function statusFor(code) {
  return STATUS_BY_CODE[code] || 400;
}

module.exports = { DomainError, statusFor };
