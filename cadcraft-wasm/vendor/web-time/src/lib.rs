//! Relógio "parado": `Instant::elapsed` e `SystemTime::now` valem zero (ver Cargo.toml).
pub use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Instant(u64);

impl Instant {
    pub fn now() -> Instant {
        Instant(0)
    }
    pub fn elapsed(&self) -> Duration {
        Duration::ZERO
    }
    pub fn duration_since(&self, _earlier: Instant) -> Duration {
        Duration::ZERO
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SystemTime(Duration);

pub const UNIX_EPOCH: SystemTime = SystemTime(Duration::ZERO);

#[derive(Clone, Debug)]
pub struct SystemTimeError(Duration);

impl std::fmt::Display for SystemTimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "second time provided was later than self")
    }
}
impl std::error::Error for SystemTimeError {}

impl SystemTime {
    pub fn now() -> SystemTime {
        UNIX_EPOCH
    }
    pub fn duration_since(&self, earlier: SystemTime) -> Result<Duration, SystemTimeError> {
        self.0.checked_sub(earlier.0).ok_or(SystemTimeError(Duration::ZERO))
    }
}
