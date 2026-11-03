-- Monthly usage meter for the $5/month spend cap (lead-owned; see api/src/budget.ts).
CREATE TABLE usage (
  month TEXT NOT NULL,
  metric TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, metric)
);
