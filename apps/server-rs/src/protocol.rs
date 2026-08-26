//! Wire types mirrored from packages/protocol (TypeScript). Additive and
//! field-for-field identical JSON: the frontend must not distinguish the
//! Rust backend from the Node one.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Zig,
    Rust,
    Go,
    Ts,
    Py,
    C,
    Cpp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<Language>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeFieldLayout {
    pub name: String,
    pub type_name: String,
    pub offset: u32,
    pub size: u32,
    pub preview: String,
}
