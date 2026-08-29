package domain

// FieldError is one field-level validation problem: a bad value, a missing
// required field, or a malformed query term. It is the shared error shape
// between runtime row coercion (CoerceFieldValue) and list-query parsing —
// both report exactly this: which field, what's wrong.
type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

func (e *FieldError) Error() string { return e.Field + ": " + e.Message }

// ErrorKind classifies why a domain operation failed, independent of any
// transport. A transport maps each kind to its own wire shape (HTTP status
// codes and error codes for api/, a denial/backend-error split for sandbox,
// whatever an MCP transport eventually wants) — the classification itself is
// decided once, here.
type ErrorKind int

const (
	ErrAppNotFound ErrorKind = iota
	ErrEntityNotFound
	ErrToolNotFound
	ErrOperationDisabled
	ErrValidation
	ErrInvalidQuery
	ErrRowNotFound
	ErrUnique
	ErrReferenceConflict
	ErrInternal
)

// OpError is the structured result of a failed domain operation. Issues is
// populated only for ErrValidation/ErrInvalidQuery.
type OpError struct {
	Kind    ErrorKind
	Message string
	Issues  []FieldError
}

func (e *OpError) Error() string { return e.Message }
