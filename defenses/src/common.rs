//! Building blocks of Dodge, needed by all defense implementations, and some
//! defense-specific constants for creation of robust anonymity sets.

use std::collections::HashMap;
use std::ops::Not;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};


/// The absolute or relative path to save extended manifests to.
pub const MFST_DIRECTORY: &str = "mfst/";

/// Label for set generation. Extended manifests for other representations
/// can be created to match the anonymity sets computed using this label.
pub const PRIMARY_LABEL: &str = "video_4000k";

/// The maximum number of segments to consider during set generation.
pub const MAX_SEGMENTS: usize = 301;

/// The minimum amount of data to request in a cycle. Used when generating
/// extended manifests when possible - if smaller segments exist, it may not
/// be possible to respect this limit in all cases. Helps with performance.
pub const MIN_CYCLE_SIZE: u64 = 512;

/// Increase ranges before header adjustment by this amount in both directions,
/// making it easier to match the target size.
pub const MARGIN: u64 = 32;

/// Induced overlap between cycle ranges to facilitate HTTP header adjustment.
/// The range start is initially reduced by this amount, and the range end can
/// thus be reduced by this amount during adjustment.
pub const OVERLAP: u64 = 16;

/// For padding segments, allow ranges to be narrowed by this amount from the
/// beginning during header adjustment (add up to TRIM_FRONT to range start).
pub const TRIM_FRONT: u64 = 100;

/// For padding segments, allow ranges to be narrowed by this amount from the
/// end during header adjustment (subtract up to TRIM_BACK from range end).
pub const TRIM_BACK: u64 = 32;

/// Compute the base URI for an extended manifest based on a video's label.
/// This function will need to be changed depending on the experiment setup.
pub fn get_base_uri(label: &str) -> Option<String> {
    // Video labels have the format XX-YYY
    let parts: Vec<&str> = label.split('-').collect();
    if parts.len() != 2 {
        panic!("get_base_uri(): invalid video label");
    }

    let xx = parts[0].parse::<u64>().ok().unwrap();
    let yyy = parts[1].parse::<u64>().ok().unwrap();

    // Run 10 data collection instances simultaneously, each corresponding to a
    // different network namespace on the server (10.1.0.1 - 10.1.9.1)
    let order = (xx * 100 + yyy) % 10;

    // We want base URIs to have the same length regardless of which video is
    // being downloaded, so use a simlink with a name that's longer by one char
    // when the third decimal part of the IP address is only one digit
    let folder = if order > 9 {
        "yt-241221"
    } else {
        "yt-241221x"
    };

    Some(format!(
        "https://10.1.{}.1/videos/{}/{}/",
        order,
        folder,
        label
    ))
}

/// Get the extended manifest path for a video based on its label.
pub fn get_mfst_path(label: &str) -> String {
    let mut p = PathBuf::from(MFST_DIRECTORY);
    p.push(format!("{}.exmfst.json", label));
    p.to_string_lossy().into_owned()
}


/// The extended manifest, the MPD's successor in Dodge.
/// Consists of some startup data and defended stream info to protect the
/// content to be downloaded during playback. Padding can be added to control
/// control the extended manifest's size for defense purposes.
#[derive(Clone, Serialize, Deserialize)]
pub struct ExtendedManifest {
    /// Startup data, consisting of the MPD and base URI for segments.
    pub start: Start,
    /// Defended stream info, to protect all available representations.
    pub streams: Vec<DefendedStream>,
    /// Optional padding to resize the MDD.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pad: Option<String>,
}

/// Bootstrap data in an extended manifest. This consists of the MPD, embedded
/// in text format, and a base URI for segment downloads.
#[derive(Clone, Serialize, Deserialize)]
pub struct Start {
    /// The MPD, in text format. Parsed directly by Dodge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mpd: Option<String>,
    /// Manifest base URI, used by dash.js for segment downloads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_uri: Option<String>,
}

/// Defended stream info for a single representation.
/// Contains a label (the representation ID), cycles to download the init
/// segment if present, and cycles to download media segments.
#[derive(Clone, Serialize, Deserialize)]
pub struct DefendedStream {
    /// A label identifying the adaptation set and quality.
    pub label: String,
    /// Cycles used to download the init segment. Index is ignored.
    pub init: Vec<Cycle>,
    /// Cycles used to download media content during playback.
    pub data: Vec<Cycle>,
}

/// A single cycle in an extended manifest, representing content to download.
/// Defined by a segment index, optional range (in which case a range request
/// will be made), and a padding flag - if set, the server's response will be
/// discarded and never passed on to the video player's buffer.
#[derive(Clone, Serialize, Deserialize)]
pub struct Cycle {
    /// Segment index. Not required for init segments.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
    /// Optional range for partial segment downloads, combined by Dodge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<String>,
    /// Optional padding flag. If set, the server's response is discarded.
    #[serde(skip_serializing_if = "<&bool>::not")]
    pub padding: bool,
    /// Optional directive. If set, combine downloaded parts of the segment
    /// with the current index and send them to the playback buffer, otherwise
    /// increment the mock buffer (if trailing).
    #[serde(skip_serializing_if = "<&bool>::not")]
    pub buffer: bool,
}

/// A single video in the dataset to be defended.
#[derive(Clone, Serialize, Deserialize)]
pub struct Video {
    /// The video's MPD, in text format.
    pub mpd: String,
    /// Init segment sizes, indexed by representation ID.
    pub init_segments: HashMap<String, u64>,
    /// Data segment sizes, indexed by representation ID.
    pub data_segments: HashMap<String, Vec<u64>>,
    /// Init segment entity tags.
    #[serde(default)]
    pub init_etags: HashMap<String, String>,
    /// Data segment entity tags.
    #[serde(default)]
    pub data_etags: HashMap<String, Vec<String>>,
    /// Video label in dataset.
    pub label: String,
}
