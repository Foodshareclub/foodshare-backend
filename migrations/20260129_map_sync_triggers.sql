-- Real-time map sync trigger
CREATE OR REPLACE FUNCTION notify_map_preferences_change()
RETURNS TRIGGER AS $$
BEGIN
    -- Notify via pg_notify for real-time updates
    PERFORM pg_notify(
        'map_preferences_updated',
        json_build_object(
            'user_id', NEW.user_id,
            'platform', NEW.platform,
            'device_id', NEW.device_id,
            'center', json_build_object(
                'lat', NEW.last_center_lat,
                'lng', NEW.last_center_lng
            ),
            'zoom', NEW.last_zoom_level,
            'timestamp', extract(epoch from NEW.updated_at)
        )::text
    );
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
DROP TRIGGER IF EXISTS map_preferences_notify_trigger ON user_map_preferences;
CREATE TRIGGER map_preferences_notify_trigger
    AFTER INSERT OR UPDATE ON user_map_preferences
    FOR EACH ROW EXECUTE FUNCTION notify_map_preferences_change();
