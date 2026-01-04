//! Error types for motherduck-sync.


use thiserror::Error;

/// Result type alias using the library's Error type.
pub type Result<T> = std::result::Result<T, Error>;

/// Main error type for motherduck-sync operations.
#[derive(Error, Debug)]
pub enum Error {
    /// Configuration error
    #[error("Configuration error: {message}")]
    Config {
        /// Error message
        message: String,
        /// Source error if any
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// PostgreSQL connection error
    #[error("PostgreSQL connection error: {message}")]
    PostgresConnection {
        /// Error message
        message: String,
        /// Source error
        #[source]
        source: Option<tokio_postgres::Error>,
    },

    /// PostgreSQL query error
    #[error("PostgreSQL query error on table '{table}': {message}")]
    PostgresQuery {
        /// Table name
        table: String,
        /// Error message
        message: String,
        /// Source error
        #[source]
        source: Option<tokio_postgres::Error>,
    },

    /// MotherDuck connection error
    #[error("MotherDuck connection error: {message}")]
    MotherDuckConnection {
        /// Error message
        message: String,
        /// Source error
        #[source]
        source: Option<duckdb::Error>,
    },

    /// MotherDuck query error
    #[error("MotherDuck query error on table '{table}': {message}")]
    MotherDuckQuery {
        /// Table name
        table: String,
        /// Error message
        message: String,
        /// Source error
        #[source]
        source: Option<duckdb::Error>,
    },

    /// Schema error
    #[error("Schema error: {message}")]
    Schema {
        /// Error message
        message: String,
    },

    /// Validation error
    #[error("Validation error: {0}")]
    Validation(String),

    /// Serialization error
    #[error("Serialization error: {message}")]
    Serialization {
        /// Error message
        message: String,
        /// Source error
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// Sync error
    #[error("Sync error: {message}")]
    Sync {
        /// Error message
        message: String,
        /// Records successfully synced before error
        records_synced: usize,
    },

    /// Retry exhausted
    #[error("Operation failed after {attempts} attempts: {message}")]
    RetryExhausted {
        /// Number of attempts made
        attempts: u32,
        /// Error message
        message: String,
        /// Last error encountered
        #[source]
        last_error: Option<Box<Error>>,
    },

    /// Cancelled
    #[error("Operation cancelled")]
    Cancelled,

    /// IO error
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl Error {
    /// Create a configuration error.
    pub fn config(message: impl Into<String>) -> Self {
        Self::Config {
            message: message.into(),
            source: None,
        }
    }

    /// Create a configuration error with source.
    pub fn config_with_source(
        message: impl Into<String>,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self::Config {
            message: message.into(),
            source: Some(Box::new(source)),
        }
    }

    /// Create a PostgreSQL connection error.
    pub fn postgres_connection(message: impl Into<String>, source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::PostgresConnection {
            message: message.into(),
            source: None, // We lose the specific type but keep the message
        }
    }

    /// Create a PostgreSQL connection error with tokio_postgres::Error.
    pub fn postgres_connection_pg(message: impl Into<String>, source: tokio_postgres::Error) -> Self {
        Self::PostgresConnection {
            message: message.into(),
            source: Some(source),
        }
    }

    /// Create a PostgreSQL query error.
    pub fn postgres_query(
        table: impl Into<String>,
        message: impl Into<String>,
        source: tokio_postgres::Error,
    ) -> Self {
        Self::PostgresQuery {
            table: table.into(),
            message: message.into(),
            source: Some(source),
        }
    }

    /// Create a MotherDuck connection error.
    pub fn motherduck_connection(message: impl Into<String>, source: duckdb::Error) -> Self {
        Self::MotherDuckConnection {
            message: message.into(),
            source: Some(source),
        }
    }

    /// Create a MotherDuck query error.
    pub fn motherduck_query(
        table: impl Into<String>,
        message: impl Into<String>,
        source: duckdb::Error,
    ) -> Self {
        Self::MotherDuckQuery {
            table: table.into(),
            message: message.into(),
            source: Some(source),
        }
    }

    /// Create a schema error.
    pub fn schema(message: impl Into<String>) -> Self {
        Self::Schema {
            message: message.into(),
        }
    }

    /// Create a validation error.
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    /// Create a sync error.
    pub fn sync(message: impl Into<String>, records_synced: usize) -> Self {
        Self::Sync {
            message: message.into(),
            records_synced,
        }
    }

    /// Check if this error is retryable.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Error::PostgresConnection { .. }
                | Error::MotherDuckConnection { .. }
                | Error::Io(_)
        )
    }

    /// Get the error code for metrics/logging.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Config { .. } => "CONFIG_ERROR",
            Error::PostgresConnection { .. } => "PG_CONNECTION_ERROR",
            Error::PostgresQuery { .. } => "PG_QUERY_ERROR",
            Error::MotherDuckConnection { .. } => "MD_CONNECTION_ERROR",
            Error::MotherDuckQuery { .. } => "MD_QUERY_ERROR",
            Error::Schema { .. } => "SCHEMA_ERROR",
            Error::Validation(_) => "VALIDATION_ERROR",
            Error::Serialization { .. } => "SERIALIZATION_ERROR",
            Error::Sync { .. } => "SYNC_ERROR",
            Error::RetryExhausted { .. } => "RETRY_EXHAUSTED",
            Error::Cancelled => "CANCELLED",
            Error::Io(_) => "IO_ERROR",
        }
    }
}

/// Error context extension trait.
pub trait ErrorContext<T> {
    /// Add context to an error.
    fn context(self, message: impl Into<String>) -> Result<T>;

    /// Add context with a closure (lazy evaluation).
    fn with_context<F>(self, f: F) -> Result<T>
    where
        F: FnOnce() -> String;
}

impl<T, E: std::error::Error + Send + Sync + 'static> ErrorContext<T>
    for std::result::Result<T, E>
{
    fn context(self, message: impl Into<String>) -> Result<T> {
        self.map_err(|e| Error::config_with_source(message, e))
    }

    fn with_context<F>(self, f: F) -> Result<T>
    where
        F: FnOnce() -> String,
    {
        self.map_err(|e| Error::config_with_source(f(), e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_codes() {
        assert_eq!(Error::config("test").code(), "CONFIG_ERROR");
        assert_eq!(Error::validation("test").code(), "VALIDATION_ERROR");
        assert_eq!(Error::schema("test").code(), "SCHEMA_ERROR");
    }

    #[test]
    fn test_retryable() {
        assert!(!Error::config("test").is_retryable());
        assert!(!Error::validation("test").is_retryable());
    }
}
