-- Derived materialized monthly snapshot. Never editable; independent of telemetry revisions.
CREATE TABLE monthly_unconfirmed_loss (
  site_id TEXT PRIMARY KEY NOT NULL REFERENCES site_settings(id) ON DELETE CASCADE,
  calculation_version INTEGER NOT NULL,
  publication_identity TEXT NOT NULL,
  review_identity TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
