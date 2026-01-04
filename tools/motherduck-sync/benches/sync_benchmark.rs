//! Benchmarks for motherduck-sync operations.

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

/// Benchmark JSON to SQL string conversion.
fn bench_json_to_sql(c: &mut Criterion) {
    let values = vec![
        JsonValue::Null,
        JsonValue::Bool(true),
        JsonValue::Number(42.into()),
        JsonValue::String("test string".into()),
        serde_json::json!({"key": "value", "nested": {"a": 1}}),
    ];

    c.bench_function("json_to_sql_string", |b| {
        b.iter(|| {
            for v in &values {
                black_box(json_to_sql_string(v));
            }
        })
    });
}

/// Benchmark row map creation.
fn bench_row_map(c: &mut Criterion) {
    c.bench_function("create_row_map", |b| {
        b.iter(|| {
            let mut map: HashMap<String, JsonValue> = HashMap::new();
            map.insert("id".into(), JsonValue::Number(1.into()));
            map.insert("name".into(), JsonValue::String("test".into()));
            map.insert("active".into(), JsonValue::Bool(true));
            map.insert("data".into(), serde_json::json!({"key": "value"}));
            black_box(map)
        })
    });
}

fn json_to_sql_string(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "NULL".to_string(),
        JsonValue::Bool(b) => b.to_string(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::String(s) => s.clone(),
        JsonValue::Array(_) | JsonValue::Object(_) => value.to_string(),
    }
}

criterion_group!(benches, bench_json_to_sql, bench_row_map);
criterion_main!(benches);
