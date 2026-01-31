-- Automated ML model training for map predictions
CREATE OR REPLACE FUNCTION train_map_prediction_model()
RETURNS jsonb AS $$
DECLARE
    v_model_stats jsonb;
    v_total_interactions bigint;
    v_unique_users bigint;
    v_avg_session_duration double precision;
BEGIN
    -- Gather training statistics
    SELECT 
        COUNT(*) as total_interactions,
        COUNT(DISTINCT user_id) as unique_users,
        AVG(duration_seconds) as avg_duration
    INTO v_total_interactions, v_unique_users, v_avg_session_duration
    FROM map_interaction_events
    WHERE created_at > now() - interval '30 days';
    
    -- Create materialized view for fast ML queries
    REFRESH MATERIALIZED VIEW CONCURRENTLY map_ml_features;
    
    -- Update model metadata
    INSERT INTO ml_model_metadata (
        model_name,
        model_version,
        training_data_size,
        accuracy_score,
        last_trained_at,
        model_config
    ) VALUES (
        'map_hotspot_predictor',
        extract(epoch from now())::text,
        v_total_interactions,
        0.85, -- Placeholder accuracy
        now(),
        jsonb_build_object(
            'algorithm', 'k-means_clustering',
            'features', array['lat', 'lng', 'zoom', 'time_of_day', 'day_of_week'],
            'min_cluster_size', 5,
            'max_clusters', 10
        )
    )
    ON CONFLICT (model_name) DO UPDATE SET
        model_version = EXCLUDED.model_version,
        training_data_size = EXCLUDED.training_data_size,
        last_trained_at = EXCLUDED.last_trained_at;
    
    v_model_stats := jsonb_build_object(
        'total_interactions', v_total_interactions,
        'unique_users', v_unique_users,
        'avg_session_duration', v_avg_session_duration,
        'model_version', extract(epoch from now())::text,
        'training_completed_at', now()
    );
    
    RETURN v_model_stats;
END;
$$ LANGUAGE plpgsql;

-- Materialized view for ML features
CREATE MATERIALIZED VIEW IF NOT EXISTS map_ml_features AS
SELECT 
    user_id,
    center_lat,
    center_lng,
    zoom_level,
    time_of_day,
    day_of_week,
    platform,
    duration_seconds,
    ST_ClusterKMeans(geom, 10) OVER (PARTITION BY user_id) as user_cluster_id,
    created_at
FROM map_interaction_events
WHERE created_at > now() - interval '30 days';

CREATE UNIQUE INDEX IF NOT EXISTS idx_map_ml_features_unique 
ON map_ml_features (user_id, created_at, center_lat, center_lng);

-- ML model metadata table
CREATE TABLE IF NOT EXISTS ml_model_metadata (
    model_name text PRIMARY KEY,
    model_version text NOT NULL,
    training_data_size bigint,
    accuracy_score double precision,
    last_trained_at timestamptz DEFAULT now(),
    model_config jsonb,
    created_at timestamptz DEFAULT now()
);

-- Schedule model retraining (daily at 2 AM)
SELECT cron.schedule(
    'retrain-map-ml-model',
    '0 2 * * *',
    'SELECT train_map_prediction_model();'
);
