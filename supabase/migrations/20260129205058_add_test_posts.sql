-- Add test posts for map engagement testing
-- Insert test food items that can be liked/bookmarked

INSERT INTO posts (
    post_name,
    post_description, 
    post_type,
    post_address,
    post_stripped_address,
    location,
    is_active,
    is_arranged,
    post_views,
    post_like_counter,
    category_id,
    created_at,
    updated_at
) VALUES 
(
    'Test Pizza for Map',
    'Delicious pizza available for pickup - test engagement',
    'food',
    '123 Test Street, San Francisco, CA',
    'Test Street, San Francisco',
    ST_GeogFromText('POINT(-122.4194 37.7749)'),
    true,
    false,
    5,
    0,
    1,
    NOW(),
    NOW()
),
(
    'Test Sandwich for Map', 
    'Fresh sandwich ready for sharing - test engagement',
    'food',
    '456 Demo Ave, San Francisco, CA',
    'Demo Ave, San Francisco',
    ST_GeogFromText('POINT(-122.4184 37.7759)'),
    true,
    false,
    3,
    0,
    1,
    NOW(),
    NOW()
),
(
    'Test Salad for Map',
    'Healthy salad available - test engagement',
    'food', 
    '789 Sample Blvd, San Francisco, CA',
    'Sample Blvd, San Francisco',
    ST_GeogFromText('POINT(-122.4204 37.7739)'),
    true,
    false,
    8,
    0,
    1,
    NOW(),
    NOW()
);