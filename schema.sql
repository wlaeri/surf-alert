CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE surf_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL,
  wave_height_ft REAL NOT NULL,
  wave_period_s REAL NOT NULL,
  wind_speed_mph REAL NOT NULL,
  wind_direction_deg INTEGER NOT NULL,
  tide_ft REAL NOT NULL,
  surf_score INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL,
  surf_score INTEGER NOT NULL,
  message TEXT NOT NULL,
  phrase TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration for existing deployments:
--   ALTER TABLE alerts ADD COLUMN phrase TEXT;

CREATE INDEX idx_surf_observations_timestamp ON surf_observations (timestamp DESC);
CREATE INDEX idx_alerts_timestamp ON alerts (timestamp DESC);
