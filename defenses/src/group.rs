//! A defense that computes optimal anonymity sets for a dataset of videos and
//! creates extended manifests for Dodge. Based in part on Bayardo & Agrawal's
//! optimal k-anonymity algorithm.

use std::collections::HashMap;
use std::f64::INFINITY;
use std::fmt;
use std::fs::{create_dir, File};
use std::io::Write;
use std::time::Instant;

use std::sync::{Arc, Mutex};
use std::thread;

use ctrlc;
use indicatif::{ProgressBar, ProgressStyle, ProgressDrawTarget};
use itertools::Itertools;
use serde::{Deserialize, Serialize};

use crate::common::*;

/// The status of the algorithm, used for early stopping.
#[derive(PartialEq, Eq)]
enum Status {
    Continue,
    Stop,
}

/// An anonymity set, whose videos will have the same traffic pattern.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct AnonymitySet {
    /// The video indices contained in the anonymity set.
    pub(crate) idxs: Vec<usize>,
    /// The video labels contained in the anonymity set, for reporting purposes.
    pub(crate) labels: Vec<String>,
    /// Labeled by representation ID, contains the sizes of all init segments.
    /// Used to make all init segment downloads for videos within the set identical.
    pub(crate) init_segments: HashMap<String, Vec<u64>>,
    /// Labeled by representation ID, contains all segment sizes at each index sorted.
    pub(crate) data_segments: HashMap<String, Vec<Vec<u64>>>,
    /// The sum of all segment sizes at every index, used for fast cost calculation.
    pub(crate) undefended_size: HashMap<String, u64>,
    /// The sum of the largest segment size at every index, times number of videos.
    pub(crate) defended_size: HashMap<String, u64>,
    /// Labeled by representation ID, the minimum value in the set {x | largest
    /// segment size for video x}, used to limit cycle sizes.
    pub(crate) max_cycle_size: HashMap<String, u64>,
    /// Minimum number of characters in an init ETag, for adjustment of HTTP headers.
    pub(crate) min_init_etag: HashMap<String, u64>,
    /// Minimum number of characters in a data ETag, for adjustment of HTTP headers.
    pub(crate) min_data_etag: HashMap<String, u64>,
}

impl fmt::Display for AnonymitySet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let overhead = 100.0 * (*self.defended_size.get(PRIMARY_LABEL).unwrap() as f64) / (*self.undefended_size.get(PRIMARY_LABEL).unwrap() as f64) - 100.0;
        write!(
            f,
            "[{}] ({}%)",
            self.labels.iter().format(", "),
            overhead.trunc()
        )
    }
}

impl AnonymitySet {
    /// Create an empty anonymity set.
    fn new() -> Self {
        AnonymitySet {
            idxs: vec![],
            labels: vec![],
            init_segments: HashMap::new(),
            data_segments: HashMap::new(),
            undefended_size: HashMap::new(),
            defended_size: HashMap::new(),
            max_cycle_size: HashMap::new(),
            min_init_etag: HashMap::new(),
            min_data_etag: HashMap::new(),
        }
    }

    /// Create a new top-level anonymity set.
    /// Takes video indices to include in the set and a vector of videos.
    fn new_top(idxs: Vec<usize>, videos: &Vec<Video>) -> Self {
        let labels = idxs.iter().map(|idx| videos[*idx].label.clone()).collect();

        let mut init_segments: HashMap<String, Vec<u64>> = HashMap::new();
        let mut data_segments: HashMap<String, Vec<Vec<u64>>> = HashMap::new();

        let mut undefended_size: HashMap<String, u64> = HashMap::new();
        let mut defended_size: HashMap<String, u64> = HashMap::new();

        let mut max_cycle_size: HashMap<String, u64> = HashMap::new();
        let mut min_init_etag: HashMap<String, u64> = HashMap::new();
        let mut min_data_etag: HashMap<String, u64> = HashMap::new();

        // Loop through all videos to be included.
        for idx in &idxs {
            let video = &videos[*idx];

            // Loop through all representations the video has.
            for (label, segments) in video.data_segments.iter() {
                // init segment
                if let Some(init_size) = video.init_segments.get(label) {
                    let init = init_segments.entry(label.clone()).or_insert(vec![]);
                    match init.binary_search(init_size) {
                        Err(pos) => init.insert(pos, *init_size),
                        _ => {}
                    }
                }

                // data segments, and undefended size
                let data = data_segments.entry(label.clone()).or_insert_with(|| {
                    let mut s = Vec::with_capacity(MAX_SEGMENTS);
                    for _ in 0..MAX_SEGMENTS {
                        s.push(vec![]);
                    }
                    s
                });

                let mut max_seg_size_rep = None;
                let mut min_data_etag_rep = None;

                for (seg_idx, seg_size) in segments.iter().enumerate() {
                    if seg_size == &0 || seg_idx >= MAX_SEGMENTS {
                        break;
                    }

                    match data[seg_idx].binary_search(seg_size) {
                        Err(pos) => data[seg_idx].insert(pos, *seg_size),
                        _ => {},
                    }

                    *undefended_size.entry(label.clone()).or_insert(0) += seg_size;

                    match max_seg_size_rep {
                        None => max_seg_size_rep = Some(*seg_size),
                        Some(x) => if *seg_size > x {
                            max_seg_size_rep = Some(*seg_size);
                        },
                    }

                    let etag = video.data_etags.get(label).unwrap().get(seg_idx).unwrap_or(&"".to_string()).len() as u64;
                    match min_data_etag_rep {
                        Some(x) => if etag < x {
                            min_data_etag_rep = Some(etag)
                        },
                        None => min_data_etag_rep = Some(etag),
                    }
                }

                // max cycle size
                if let Some(limit) = max_cycle_size.get(label) {
                    if max_seg_size_rep.unwrap() < *limit {
                        max_cycle_size.insert(label.clone(), max_seg_size_rep.unwrap());
                    }
                } else {
                    max_cycle_size.insert(label.clone(), max_seg_size_rep.unwrap());
                }

                // min etag size
                let min_init_etag_rep = video.init_etags.get(label).unwrap_or(&"".to_string()).len() as u64;
                let ref_etag_init = min_init_etag.entry(label.clone()).or_insert(min_init_etag_rep);
                if min_init_etag_rep < *ref_etag_init {
                    *ref_etag_init = min_init_etag_rep;
                }

                let min_data_etag_rep = min_data_etag_rep.unwrap_or(0);
                let ref_etag_data = min_data_etag.entry(label.clone()).or_insert(min_data_etag_rep);
                if min_data_etag_rep < *ref_etag_data {
                    *ref_etag_data = min_data_etag_rep;
                }
            }
        }

        // defended size
        for (label, seg_sizes) in data_segments.iter() {
            let defended_size = defended_size.entry(label.clone()).or_insert(0);
            for i in 0..MAX_SEGMENTS {
                *defended_size += seg_sizes[i].get(seg_sizes[i].len() - 1).unwrap_or(&0);
            }
            *defended_size *= idxs.len() as u64;
        }

        for idx in idxs.iter() {
            for (label, seg_sizes) in videos[*idx].data_segments.iter() {
                let mut max_val = None;
                for val in seg_sizes.iter() {
                    match max_val {
                        None => max_val = Some(val),
                        Some(x) => if val > x {
                            max_val = Some(val)
                        },
                    }
                }
                if let Some(max_val) = max_val {
                    if max_val < max_cycle_size.get(label).unwrap() {
                        max_cycle_size.insert(label.clone(), *max_val);
                    }
                } else {
                    panic!("no segments");
                }
            }
        }

        AnonymitySet {
            idxs,
            labels,
            init_segments,
            data_segments,
            undefended_size,
            defended_size,
            max_cycle_size,
            min_init_etag,
            min_data_etag
        }
    }

    /// Add a video/s to the set, maintaining the sorted order of segments.
    /// Takes video indices to include in the set and a vector of videos.
    fn add(&mut self, idxs: Vec<usize>, videos: &Vec<Video>) {
        let mut defended_size: HashMap<String, u64> = HashMap::new();

        // Loop through all videos to be included.
        for idx in &idxs {
            let video = &videos[*idx];

            // Loop through all representations the video has.
            for (label, values) in video.data_segments.iter() {
                // init segment
                if let Some(init_size) = video.init_segments.get(label) {
                    let init = self.init_segments.entry(label.clone()).or_insert(vec![]);
                    match init.binary_search(init_size) {
                        Err(pos) => init.insert(pos, *init_size),
                        _ => {}
                    }
                }

                // data segments
                let mut max_seg_size_rep = None;
                let mut min_data_etag_rep = None;

                let data = self.data_segments.entry(label.clone()).or_insert_with(|| {
                    let mut s = Vec::with_capacity(MAX_SEGMENTS);
                    for _ in 0..MAX_SEGMENTS {
                        s.push(vec![]);
                    }
                    s
                });

                for (seg_idx, seg_size) in values.iter().enumerate() {
                    if seg_size == &0 || seg_idx >= MAX_SEGMENTS {
                        break;
                    }

                    match data[seg_idx].binary_search(seg_size) {
                        Err(pos) => data[seg_idx].insert(pos, *seg_size),
                        _ => {}
                    }

                    *self.undefended_size.entry(label.clone()).or_insert(0) += seg_size;

                    match max_seg_size_rep {
                        None => max_seg_size_rep = Some(*seg_size),
                        Some(x) => if *seg_size > x {
                            max_seg_size_rep = Some(*seg_size);
                        },
                    }

                    let etag = video.data_etags.get(label).unwrap().get(seg_idx).unwrap_or(&"".to_string()).len() as u64;
                    match min_data_etag_rep {
                        Some(x) => if etag < x {
                            min_data_etag_rep = Some(etag)
                        },
                        None => min_data_etag_rep = Some(etag),
                    }
                }

                // max cycle size
                if let Some(limit) = self.max_cycle_size.get(label) {
                    if max_seg_size_rep.unwrap() < *limit {
                        self.max_cycle_size.insert(label.clone(), max_seg_size_rep.unwrap());
                    }
                } else {
                    self.max_cycle_size.insert(label.clone(), max_seg_size_rep.unwrap());
                }

                // min etag size
                let min_init_etag_rep = video.init_etags.get(label).unwrap_or(&"".to_string()).len() as u64;
                let ref_etag_init = self.min_init_etag.entry(label.clone()).or_insert(min_init_etag_rep);
                if min_init_etag_rep < *ref_etag_init {
                    *ref_etag_init = min_init_etag_rep;
                }

                let min_data_etag_rep = min_data_etag_rep.unwrap_or(0);
                let ref_etag_data = self.min_data_etag.entry(label.clone()).or_insert(min_data_etag_rep);
                if min_data_etag_rep < *ref_etag_data {
                    *ref_etag_data = min_data_etag_rep;
                }
            }

            self.idxs.push(*idx);
            self.labels.push(video.label.clone());
        }

        // defended size
        for (label, seg_sizes) in self.data_segments.iter() {
            let defended_size = defended_size.entry(label.clone()).or_insert(0);
            for i in 0..MAX_SEGMENTS {
                *defended_size += seg_sizes[i].get(seg_sizes[i].len() - 1).unwrap_or(&0);
            }
            *defended_size *= self.idxs.len() as u64;
        }
        self.defended_size = defended_size;

        for idx in self.idxs.iter() {
            for (label, seg_sizes) in videos[*idx].data_segments.iter() {
                let mut max_val = None;
                for val in seg_sizes.iter() {
                    match max_val {
                        None => max_val = Some(val),
                        Some(x) => if val > x {
                            max_val = Some(val)
                        },
                    }
                }
                if let Some(max_val) = max_val {
                    if max_val < self.max_cycle_size.get(label).unwrap() {
                        self.max_cycle_size.insert(label.clone(), *max_val);
                    }
                } else {
                    panic!("no segments");
                }
            }
        }
    }
}

/// The state of the algorithm, shared across all threads.
/// This struct is designed to be as minimal as possible to minimize waiting
/// for locks and consists mainly of a start time (never updated) and each
/// worker's lowest cost and best anonymity sets so far, as displayed to
/// the user. Also used to synchronize extended manifest generation.
struct GlobalState {
    /// The start time of the algorithm.
    start: Instant,
    /// The best state reached by each worker thread so far.
    best_states: Vec<LocalState>,
    /// The per-worker cost during set generation, sum to get total cost.
    initial_costs: Vec<f64>,
    /// The total undefended and defended size in bytes, computed after
    /// constructing extended manifests, where overhead can increase.
    final_costs: Vec<HashMap<String, Vec<(u64, u64)>>>,
    /// The current anonymity sets in each worker thread.
    sets: Vec<String>,
    /// Have we received a Ctrl-C from the user?
    stop: bool,
    /// Progress bar for manifest generation
    pb: ProgressBar,
}

impl GlobalState {
    fn new(workers: usize, progress_len: u64) -> Self {
        let best_states = Vec::with_capacity(workers);
        let mut initial_costs = Vec::with_capacity(workers);
        let mut final_costs = Vec::with_capacity(workers);
        let mut sets = Vec::with_capacity(workers);
        for _ in 0..workers {
            initial_costs.push(INFINITY);
            final_costs.push(HashMap::new());
            sets.push(String::new());
        }

        let pb = ProgressBar::with_draw_target(Some(progress_len), ProgressDrawTarget::stderr());
        pb.set_prefix("Videos");
        pb.set_style(ProgressStyle::default_bar()
            .template("{spinner:.green} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {pos}/{len} ({eta})")
            .unwrap()
            .progress_chars("#>-"));

        GlobalState {
            start: Instant::now(),
            best_states,
            initial_costs,
            final_costs,
            sets,
            stop: false,
            pb,
        }
    }
}

/// The state of each individual worker thread.
/// This struct compromises the video indices under consideration, a total
/// order of (seg idx, seg size) pairs, all current sets, a stack describing
/// how the current sets have been constructed from the top-level set, and all
/// videos. Note that a bit of memory is duplicated in each worker thread, but
/// this makes the algorithm simpler as we avoid accessing shared memory.
#[derive(Clone)]
struct LocalState {
    /// The video indices considered by this worker.
    idxs: Vec<usize>,
    /// All videos, including those not considered here.
    videos: Vec<Video>,

    /// The current best anonymity sets computed by this worker.
    sets: Vec<AnonymitySet>,
    /// A stack describing how the current sets have been built.
    stack: Vec<(usize, usize)>,
    /// A total order of (seg idx, seg size) pairs.
    total_order: Vec<(usize, u64)>,
}

impl LocalState {
    fn new(idxs: Vec<usize>, videos: Vec<Video>) -> Self {
        let top = AnonymitySet::new_top(idxs.clone(), &videos);

        // Define the total order of (seg idx, seg size) pairs
        let mut total_order = vec![];
        if let Some(data) = top.data_segments.get(PRIMARY_LABEL) {
            for (seg_idx, seg_sizes) in data.iter().enumerate() {
                if seg_sizes.len() <= 1 {
                    continue;
                }

                // Don't include zero, or max seg size (implicit)
                for seg_size in seg_sizes.iter().take(seg_sizes.len() - 1) {
                    if seg_size != &0 {
                        total_order.push((seg_idx, *seg_size));
                    }
                }
            }
        }

        let sets = vec![top];
        let stack = vec![];

        LocalState {
            idxs,
            videos,
            sets,
            stack,
            total_order,
        }
    }
}

/// Run the algorithm with the given parameters. This function will return
/// once the best solution is found but may be stopped early without issue.
pub fn defend(k: usize, seed: Option<f64>, videos: Vec<Video>, workers: usize) {
    let _ = create_dir(MFST_DIRECTORY);

    // Ensure reasonable arguments
    let seed = seed.unwrap_or(INFINITY);

    if k < 2 {
        panic!("defend(): too small k, must be at least 2");
    }
    if workers < 1 {
        panic!("defend(): not enough workers, must be at least 1");
    }
    if videos.len().div_ceil(workers) < 2 * k {
        panic!(
            "defend(): too many workers for dataset size, maximum {}",
            videos.len() / (2 * k)
        );
    }

    // Create the "idx" vector for each worker
    let mut idxs: Vec<Vec<usize>> = (0..videos.len())
        .collect::<Vec<_>>()
        .chunks(videos.len().div_ceil(workers))
        .map(|v| v.into())
        .collect();

    // Set up global state (statistics and reporting)
    // Note that the status bar assumes one representation, which works
    // but it may show some funky statuses/not be so useful at times...
    let global_state = GlobalState::new(workers, (videos.len() / k * MAX_SEGMENTS) as u64);
    let global_state = Arc::new(Mutex::new(global_state));

    // Set Ctrl-C handler for early stopping
    let ctrlc_state = Arc::clone(&global_state);
    ctrlc::set_handler(move || {
        let global_state = &ctrlc_state;
        let mut global_state = global_state.lock().unwrap();
        global_state.stop = true;
    })
    .expect("defend(): could not set Ctrl-C handler");

    // Create and start worker threads
    let mut handles = vec![];

    for i in 0..workers {
        let mut local_state = LocalState::new(idxs.remove(0), videos.clone());
        let global_state = Arc::clone(&global_state);
        global_state.lock().unwrap().best_states.push(local_state.clone());

        let handle = thread::spawn(move || {
            k_anonymize(
                k,
                &mut vec![],
                &mut local_state.total_order.clone(),
                &mut local_state,
                &global_state,
                seed,
                i,
            );

            // Save extended manifests
            save_manifests_padding(&global_state, i);
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }

    // Print overhead statistics
    let global_state = global_state.lock().unwrap();
    let mut global_stats = HashMap::new();

    global_state.pb.finish_with_message("Done!");

    for (worker_idx, map) in global_state.final_costs.iter().enumerate() {
        println!("--- worker {} ---", worker_idx);

        for (label, values) in map.iter() {
            if label == PRIMARY_LABEL {
                println!("{} (primary)", label);
            } else {
                println!("{}", label);
            }

            let mut all_sets_undef = 0;
            let mut all_sets_def = 0;

            for (set_idx, (undef_size, def_size)) in values.iter().enumerate() {
                let overhead = *def_size as f64 / *undef_size as f64 - 1.0;
                println!("* set {}: overhead = {:.3}, bytes = {}, undefended size = {}, defended size = {}", set_idx, overhead, def_size - undef_size, undef_size, def_size);

                all_sets_undef += undef_size;
                all_sets_def += def_size;
            }

            let overhead = all_sets_def as f64 / all_sets_undef as f64 - 1.0;
            println!("* total: overhead = {:.3}, bytes = {}, undefended size = {}, defended size = {}", overhead, all_sets_def - all_sets_undef, all_sets_undef, all_sets_def);
            println!();

            let global = global_stats.entry(label.clone()).or_insert((0, 0));
            *global = (global.0 + all_sets_undef, global.1 + all_sets_def);
        }

        println!();
    }

    println!("--- overall ---");

    for (label, (undef_size, def_size)) in global_stats.iter() {
        if label == PRIMARY_LABEL {
                println!("{} (primary)", label);
            } else {
                println!("{}", label);
            }

        let overhead = *def_size as f64 / *undef_size as f64 - 1.0;
        println!("* total: overhead = {:.3}, bytes = {}, undefended size = {}, defended size = {}", overhead, def_size - undef_size, undef_size, def_size);
        println!();
    }
}

/// The actual anonymization function. First, update the best cost if we have
/// better sets now. Next, prune useless values from the tail set and reorder
/// it to nudge the algorithm towards better splits. Finally, try splitting
/// existing sets on each value in the tail set (recursive calls).
fn k_anonymize(
    k: usize,
    head_set: &mut Vec<(usize, u64)>,
    tail_set: &mut Vec<(usize, u64)>,
    local_state: &mut LocalState,
    global_state: &Arc<Mutex<GlobalState>>,
    best_cost: f64,
    index: usize,
) -> (f64, Status) {
    let mut best_cost = best_cost.min(compute_cost(local_state));

    {
        let mut global_state = global_state.lock().unwrap();

        if best_cost < global_state.initial_costs[index] {
            // Update global state
            global_state.best_states[index] = local_state.clone();
            global_state.sets[index] = String::new();
            for s in &local_state.sets {
                let undef_size = *s.undefended_size.get(PRIMARY_LABEL).unwrap();
                let def_size = *s.defended_size.get(PRIMARY_LABEL).unwrap();
                let overhead = def_size as f64 / undef_size as f64 - 1.0;

                global_state.sets[index] += format!("{}, overhead = {}, undefended size = {}, defended size = {}\n", s, overhead, undef_size, def_size).as_str();
            }
            global_state.initial_costs[index] = best_cost;

            // Print current progress
            let overall_cost = global_state.initial_costs.iter().fold(0.0, |acc, cost| acc + cost) / local_state.videos.len() as f64;
            let start = global_state.start;

            println!(
                "{:.3}, overhead = {:.3} (worker {}, {:.3})",
                start.elapsed().as_secs_f64(),
                overall_cost,
                index,
                best_cost / local_state.idxs.len() as f64
            );
            for s in &global_state.sets {
                print!("{}", s);
            }
            println!();
        }

        if global_state.stop {
            return (best_cost, Status::Stop);
        }
    }

    prune_useless_values(k, tail_set, local_state);
    reorder_tail_set(tail_set, local_state);

    while let Some(value) = tail_set.pop() {
        head_set.push(value);
        let added_to_stack = eq_push(value, local_state);

        let (bc, status) = k_anonymize(
            k,
            head_set,
            &mut tail_set.clone(),
            local_state,
            global_state,
            best_cost,
            index,
        );
        best_cost = bc;

        if status == Status::Stop {
            return (best_cost, Status::Stop);
        }

        eq_pop(added_to_stack, local_state);
        head_set.pop();
    }

    return (best_cost, Status::Continue);
}

/// Helper function to count the number of digits in a number.
fn digit_count(n: u64) -> u64 {
    if n == 0 {
        1
    } else {
        ((n as f64).log10().floor() as u64) + 1
    }
}

/// Compute the estimated header size based on range start, range end, total
/// resource size, and character count in the entity tag. Accounts for Content-
/// Range, Content-Length, and ETag headers
fn estimated_header_size(s: u64, e: u64, total: u64, etag_digits: u64) -> u64 {
    digit_count(s) + digit_count(e) + digit_count(e - s + 1) + digit_count(total) + etag_digits
}

/// Modify a byte range (s..=e) to adjust HTTP response headers.
/// Shrink from the front and back up to trim_front and trim_back,
/// respectively. Set these to None to specify no limit on narrowing.
/// Returns a 3-tuple: (range start, range end, is exact match)
fn adjust_range(
    s: u64,
    e: u64,
    total_size: u64,
    etag_digits: u64,
    trim_front: Option<u64>, // trim front? None = unlimited
    trim_back: Option<u64>, // trim back? None = unlimited
    target: u64,
) -> (u64, u64, bool) {
    let original_header_size = estimated_header_size(s, e, total_size, etag_digits);
    let original_content_size = e - s + 1;

    let max_front_trim = match trim_front {
        None => original_content_size - 1,
        Some(x) => x.min(original_content_size - 1),
    };

    let mut best = (s, e, original_header_size + original_content_size);
    let mut best_diff = (best.2 as i64 - target as i64).abs();

    'outer: for front in 0..=max_front_trim {
        let new_s = s + front;
        let remaining = original_content_size - front;

        let max_back_trim = match trim_back {
            None => remaining - 1,
            Some(x) => x.min(remaining - 1),
        };

        for back in 0..=max_back_trim {
            let new_e = e - back;

            let size = estimated_header_size(new_s, new_e, total_size, etag_digits) + new_e - new_s + 1;
            if size == target {
                return (new_s, new_e, true);
            }

            let diff = (size as i64 - target as i64).abs();
            if diff < best_diff {
                best = (new_s, new_e, size);
                best_diff = diff;
            }

            if size < target {
                // decreasing more won't help
                if back == 0 {
                    break 'outer;
                } else {
                    break;
                }
            }
        }
    }
    
    (best.0, best.1, best.2 == target)
}

/// Create extended manifests from the produced sets for all representations.
/// The algorithm operates on a set of segments at a time, those for videos in
/// the same anonymity set, in the same representation, at a specific index.
/// These are *corresponding segments* and a sequence of cycles must be created
/// to download each one. Critically, these must appear identical to a network
/// observer: requests are handled via padding in the Dodge framework, but we
/// must control response sizes so that the sequence of response sizes is
/// identical for each of the corresponding segments.
fn save_manifests_padding(global_state: &Arc<Mutex<GlobalState>>, index: usize) {
    // video index -> extended manifest
    let mut mfsts: HashMap<usize, ExtendedManifest> = HashMap::new();
    // Convert every extended manifest to JSON and store the sizes of the
    // strings. This will determine how much padding is added so extended
    // manifests have the same size within each anonymity set. This
    // protects manifest traffic as long as *compression is off*.
    let mut json_sizes: HashMap<usize, usize> = HashMap::new();

    let state;
    {
        state = global_state.lock().unwrap().best_states[index].clone();
    }

    // Loop through all *anonymity sets* and create extended manifests for
    // the videos in each set.
    for (set_idx, set) in state.sets.iter().enumerate() {
        // video index -> defended streams (to be added to extended manifest)
        let mut defended_stream_info: HashMap<usize, Vec<DefendedStream>> = HashMap::new();

        // Statistics: count actual undefended and defended bytes. We already
        // have set-level statistics, but only for the primary representation.
        // Also, defended bytes may be a bit different due to the things that
        // happen here (adjustment for HTTP headers, etc.)
        let mut defended_size_actual: HashMap<String, u64> = HashMap::new();

        // Construct corresponding cycles in parallel, segment-by-segment.
        // We are now considering a specific *anonymity set*, here we loop
        // through all *representations* (label) and all segment sizes in
        // the set within each representation (values).
        for (label, values) in set.data_segments.iter() {
            // video index -> init/data cycles (to be added to defended stream)
            let mut init_cycles: HashMap<usize, Vec<Cycle>> = HashMap::new();
            let mut data_cycles: HashMap<usize, Vec<Cycle>> = HashMap::new();

            // Due to how dash.js is implemented and the desire to create a
            // simple base algorithm which can then be expanded, we can only
            // download resources corresponding to the current video within the
            // Dodge player. Thus, to ensure that we don't try to create cycles
            // for more data than is contained within any segment, we limit
            // cycle sizes (response size) to the minimum value in the set
            // {x | largest segment size for video x}, for all x in the
            // current anonymity set
            let mut upper_bound = *set.max_cycle_size.get(label).unwrap();

            // Now, we are approaching the primary logic of the algorithm,
            // after initializing a few important variables. We loop through
            // every *segment index* here and create cycles for each index.
            for (seg_idx, seg_sizes) in values.iter().enumerate() {
                // no segments at this index, done with representation!
                if seg_sizes.is_empty() {
                    break;
                }

                // total content downloaded so far at index, by all of the
                // cycles that have been created up to this point
                let mut cycle_sum: u64 = 0;

                // Maximum segment size at this index, for computing unit size.
                let max_at_index = *seg_sizes.get(seg_sizes.len() - 1).unwrap();

                // What we do now is iterate over every *segment size* at this
                // index, within this representation, within this anonymity set
                // and ensure that we have created cycles to cover the content
                // of all segments with each size. If we haven't yet, create
                // them now - this is where all cycle creation happens.
                for ss in seg_sizes.iter() {
                    // Estimated HTTP header sizes, used in the step below.
                    let mut header_sizes = vec![];

                    // Create cycles until we cover all segments with the
                    // current segment size.
                    while cycle_sum < *ss {
                        // Unit size: if we need to make a cycle, we want to make
                        // it as large as possible. Thus, it will have the current
                        // size we're looking at (can't exceed that size), but not
                        // if that means exceeding the upper bound. Also, limit to
                        // how much we actually need to download all segments at
                        // the current segment index.
                        let remaining = max_at_index.saturating_sub(cycle_sum);
                        let unit_size = *ss.min(&upper_bound).min(&remaining.max(MIN_CYCLE_SIZE));

                        // Go through all videos in the set and see which ones
                        // need content to be downloaded by the next cycle, to
                        // get estimated header sizes with the desired range
                        // (HTTP Range matching unit_size). The goal is to have
                        // a target size for content + header, as corresponding
                        // cycles must appear identical to an observer, who can
                        // see both. We use real header sizes to avoid unneeded
                        // magic numbers and such.
                        for video_idx in set.idxs.iter() {
                            let download_idx = seg_idx;
                            let download_size = *state.videos[*video_idx].data_segments.get(label).and_then(|v| v.get(seg_idx)).unwrap_or(&0);
                            let mut range_start = cycle_sum.saturating_sub(OVERLAP);
                            let mut range_end = cycle_sum + unit_size - 1;

                            if download_size == 0 || cycle_sum >= download_size || *ss > download_size {
                                continue;
                            }
                            let mut max_val = None;
                            for val in state.videos[*video_idx].data_segments.get(label).unwrap().iter() {
                                match max_val {
                                    None => max_val = Some(val),
                                    Some(x) => if val > x {
                                        max_val = Some(val)
                                    },
                                }
                            }
                            if let Some(max_val) = max_val {
                                if max_val < &upper_bound {
                                    upper_bound = *max_val;
                                }
                            } else {
                                panic!("no segments");
                            }

                            let etag_chars = state.videos[*video_idx].data_etags.get(label).and_then(|v| v.get(download_idx)).map_or(0, |etag| etag.len() as u64);

                            // adjust range start if needed, overlap with prior
                            // cycles is acceptable to ahcieve target size
                            if range_end > download_size - 1 {
                                let diff_back = range_end - download_size + 1;
                                let diff_front = diff_back.min(range_start);

                                range_start -= diff_front;
                                range_end -= diff_back;
                            }

                            // compute and store header size
                            let header_size = estimated_header_size(range_start, range_end, download_size, etag_chars);
                            header_sizes.push(header_size);
                        }

                        // minimum header size and maximum header size
                        let hd_min = *header_sizes.get(0).unwrap();
                        let hd_max = *header_sizes.get(header_sizes.len() - 1).unwrap();

                        // Define a target size (content + header) and "header
                        // in use" used as a target value for range adjustment.
                        // We use the minimum header if the range is the whole
                        // segment, as we can't achieve a higher target size.
                        // Otherwise, we use as much as we can, up to hd_max.
                        let (mut target_size, header_in_use) = if *ss.min(&upper_bound) >= unit_size + hd_max {
                            (unit_size, hd_max)
                        } else {
                            (*ss.min(&upper_bound), hd_min)
                        };

                        // Power-of-ten adjustment: especially at powers of 10,
                        // it can be impossible to match the target size due to
                        // the number of digits in the HTTP header changing as
                        // we modify the range. We avoid these situations by
                        // allowing a comfortable margin to digit boundaries
                        if target_size > 3 * header_in_use && digit_count(target_size) != digit_count(target_size - 2 * header_in_use) {
                            target_size -= 2 * header_in_use;
                        }

                        // Minimum amount of content downloaded this iteration,
                        // to increment cycle_sum. This is based on the final
                        // adjusted ranges.
                        let mut min_content: Option<u64> = None;

                        // Now that we have a target size and header size for
                        // range adjustment, actually create cycles. Create a
                        // padding cycle if no content is needed for a video.
                        for video_idx in set.idxs.iter() {
                            let mut download_idx = seg_idx;
                            let mut download_size = *state.videos[*video_idx].data_segments.get(label).and_then(|v| v.get(seg_idx)).unwrap_or(&0);
                            let mut range_start = cycle_sum.saturating_sub(OVERLAP);
                            let mut range_end = range_start + target_size - header_in_use - 1;
                            let mut padding = false;

                            // If there's no segment at this index, it is
                            // smaller than the current unit size, or we have
                            // already covered the segment, use the video's
                            // largest segment and create a padding cycle.
                            if download_size == 0 || cycle_sum >= download_size || *ss > download_size {
                                for (si_pad, ss_pad) in state.videos[*video_idx].data_segments.get(label).unwrap().iter().enumerate() {
                                    if *ss_pad > download_size {
                                        download_idx = si_pad;
                                        download_size = *ss_pad;
                                    }
                                }
                                if download_size < target_size {
                                    panic!("target size {} (ss = {}, upper bound = {}, remaining = {}, download size {})", target_size, ss, upper_bound, remaining, download_size);
                                }
                                range_start = 0;
                                range_end = target_size;
                                padding = true;
                            }

                            let etag_chars = state.videos[*video_idx].data_etags.get(label).and_then(|v| v.get(download_idx)).map_or(0, |etag| etag.len() as u64);

                            // Adjust the range if needed to fit within the
                            // resource bounds, and add some margin if we can
                            // to make range adjustment easier.
                            let mut new_range_start = range_start.saturating_sub(MARGIN);
                            let mut new_range_end = range_end + MARGIN;

                            if new_range_end > download_size - 1 {
                                let diff_back = new_range_end - download_size + 1;
                                let diff_front = diff_back.min(new_range_start);

                                new_range_start -= diff_front;
                                new_range_end -= diff_back;
                            }

                            // Adjust the range to account for HTTP headers.
                            let max_trim_front = if padding {
                                Some(TRIM_FRONT)
                            } else {
                                Some(cycle_sum.saturating_sub(new_range_start))
                            };

                            let max_trim_back = if padding {
                                Some(TRIM_BACK)
                            } else if range_end < download_size - 1 || range_start == 0 {
                                Some(OVERLAP + new_range_end.saturating_sub(range_end))
                            } else {
                                Some(0)
                            };

                            let (new_range_start, new_range_end, is_exact_match) = adjust_range(new_range_start, new_range_end, download_size, etag_chars, max_trim_front, max_trim_back, target_size);
                            if !is_exact_match {
                                panic!("save_manifests_padding(): video {}, label {}, {}-{}/{} (size {}/{}), padding = {}. ss, upper_bound, remaining {} {} {}", video_idx, label, new_range_start, new_range_end, download_size, new_range_end - new_range_start + 1 + estimated_header_size(new_range_start, new_range_end, download_size, etag_chars), target_size, padding, ss, upper_bound, remaining);
                            }

                            // Create a data cycle and update min_content.
                            data_cycles.entry(*video_idx).or_insert(vec![]).push(Cycle {
                                index: Some(download_idx),
                                range: Some(format!("{}-{}", new_range_start, new_range_end).to_string()),
                                padding,
                                buffer: false,
                            });

                            if !padding && new_range_end < download_size - 1 {
                                let progress = new_range_end - cycle_sum + 1;

                                if let Some(mc) = min_content {
                                    min_content = Some(mc.min(progress));
                                } else {
                                    min_content = Some(progress);
                                }
                            }

                            *defended_size_actual.entry(label.clone()).or_insert(0) += new_range_end - new_range_start + 1;
                        }

                        if let Some(mc) = min_content {
                            cycle_sum += mc;
                        } else {
                            cycle_sum = *ss;
                        }

                        header_sizes.clear();
                    }
                }

                for video_idx in set.idxs.iter() {
                    let cycles = data_cycles.get_mut(video_idx).unwrap();
                    let len = cycles.len() - 1;
                    cycles.get_mut(len).unwrap().buffer = true;
                }

                // Update the progress bar.
                {
                    let global_state = global_state.lock().unwrap();
                    global_state.pb.inc(1);
                }
            }
            
            // Create init cycles, based on similar principles but easier.
            for video_idx in &set.idxs {
                let cycle_init_entry = init_cycles.entry(*video_idx).or_insert(vec![]);

                // just leave an empty vector if no init data
                let values;
                if let Some(v) = &set.init_segments.get(label) {
                    if v.is_empty() {
                        continue;
                    }
                    values = *v;
                } else {
                    continue;
                }

                // determine unit size (smallest init segment), target size
                // (largest init segment), and actual size
                let unit_size = *values.get(0).unwrap();
                let total_size = *values.get(values.len() - 1).unwrap();
                let actual_size = state.videos[*video_idx].init_segments.get(label).expect(
                    format!(
                        "save_manifests_padding(): video {}, init_segments does not contain label {}",
                        video_idx,
                        label
                    )
                    .as_str(),
                );
                
                let mut next_byte = 0;

                while next_byte < total_size {
                    let mut range_start = next_byte;
                    let mut range_end = next_byte + unit_size - 1;
                    let mut diff = 0;

                    if range_end > actual_size - 1 {
                        diff = range_end - actual_size + 1;
                        range_start -= diff;
                        range_end -= diff;
                    }

                    let etag_chars = state.videos[*video_idx]
                        .init_etags
                        .get(label)
                        .unwrap_or(&"".to_string())
                        .len() as u64;
                    let trim_front = if next_byte == 0 {
                        Some(0)
                    } else {
                        Some(diff as u64)
                    };
                    let trim_back = if next_byte == 0 {
                        None
                    } else {
                        Some(0)
                    };

                    let (range_start, range_end, is_exact_match) = adjust_range(range_start, range_end, *actual_size, etag_chars, trim_front, trim_back, unit_size);
                    if !is_exact_match {
                        eprintln!("save_manifests_padding(): video {}, label {}, init segment -- adjustment size {} -> {}, leakage unavoidable!", video_idx, label, unit_size, range_end - range_start + 1);
                        panic!("range start = {}, range end = {}, next_byte = {}, diff = {}", range_start, range_end, next_byte, diff);
                    }

                    cycle_init_entry.push(Cycle {
                        index: None,
                        range: Some(format!("{}-{}", range_start, range_end).to_string()),
                        padding: false,
                        buffer: false,
                    });

                    next_byte += range_end - range_start + 1;
                }

                defended_stream_info.entry(*video_idx).or_insert(vec![]).push(DefendedStream {
                    label: label.clone(),
                    init: init_cycles.remove(video_idx).unwrap(),
                    data: data_cycles.remove(video_idx).unwrap(),
                });
            }
        }

        // Create extended manifests from defended streams.
        for video_idx in &set.idxs {
            let mfst = ExtendedManifest {
                start: Start {
                    mpd: Some(state.videos[*video_idx].mpd.clone()),
                    base_uri: get_base_uri(&state.videos[*video_idx].label),
                },
                streams: defended_stream_info.remove(video_idx).unwrap(),
                pad: Some("".to_string()),
            };

            let mut mfst_size = serde_json::to_string_pretty(&mfst).unwrap().len();

            let max = json_sizes.get_mut(&set_idx);
            if max.is_none() || max.unwrap() < &mut mfst_size {
                json_sizes.insert(set_idx, mfst_size);
            }
            mfsts.insert(*video_idx, mfst);
        }

        // update global statistics
        {
            let mut global_state = global_state.lock().unwrap();

            for (label, undef_size) in set.undefended_size.iter() {
                let def_size = defended_size_actual.get(label).unwrap();

                let entry = global_state.final_costs[index].entry(label.clone()).or_insert(vec![]);
                entry.push((*undef_size, *def_size));
            }
        }
    }

    for (set_idx, set) in state.sets.iter().enumerate() {
        for idx in &set.idxs {
            if let Some(mut mfst) = mfsts.remove(idx) {
                // Add padding based on other extended manifests' sizes.
                let mfst_json = serde_json::to_string_pretty(&mfst).unwrap();

                let max_size = json_sizes.get(&set_idx).unwrap();
                let pad = max_size - mfst_json.len();
                if pad > 0 {
                    mfst.pad = Some((0..pad).map(|_| "A").collect::<String>());
                }

                // Get the updated extended manifest with proper padding.
                let mfst_json = serde_json::to_string_pretty(&mfst).unwrap();

                let path = get_mfst_path(&state.videos[*idx].label);
                let mut file = File::create(path)
                    .expect("save_manifests_padding(): failed to create extended manifest file");
                writeln!(file, "{}", mfst_json)
                    .expect("save_manifests_padding(): failed to write to extended manifest file");
            }
        }
    }
}

/// Split anonymity sets (specialize).
/// More specifically, take a (seg idx, seg size) pair and split existing sets
/// as follows: for each video in the set, if the segment size at `seg idx` is
/// less than or equal to `seg size`, put it in one set; otherwise, put it in
/// another. Update the stack to reflect the new sets.
fn eq_push(value: (usize, u64), state: &mut LocalState) -> usize {
    let len = state.sets.len();
    let mut added_to_stack = 0;

    for i in (0..len).rev() {
        let idxs = &state.sets[i].idxs;
        let mut set_a = AnonymitySet::new();
        let mut set_b = AnonymitySet::new();

        for v in idxs.iter() {
            let seg_size = state.videos[*v]
                .data_segments
                .get(PRIMARY_LABEL)
                .unwrap()
                .get(value.0)
                .unwrap_or(&0);

            if seg_size <= &value.1 {
                set_a.add(vec![*v], &state.videos);
            } else {
                set_b.add(vec![*v], &state.videos);
            }
        }

        if set_a.idxs.len() == 0 || set_b.idxs.len() == 0 {
            continue;
        }

        state.sets.remove(i);
        state.sets.push(set_a);
        state.sets.push(set_b);

        state.stack.push((i, state.sets.len() - 2));
        added_to_stack += 1;
    }

    return added_to_stack;
}

/// Merge anonymity sets (generalize).
/// Undo the changes reflected in the stack: `count` sets have been split into
/// two, so restore them to their previous states.
fn eq_pop(count: usize, state: &mut LocalState) {
    for _ in 0..count {
        let (old_idx, new_idx) = state
            .stack
            .pop()
            .expect("eq_pop(): not enough items in stack");

        let mut set_a = state.sets.remove(new_idx);
        let set_b = state.sets.remove(new_idx);

        set_a.add(set_b.idxs, &state.videos);

        state.sets.insert(old_idx, set_a);
    }
}

/// Simple, fast overhead metric based on bandwidth overhead.
fn compute_cost(state: &LocalState) -> f64 {
    let mut undef_size = 0;
    let mut def_size = 0;

    for s in state.sets.iter() {
        undef_size += s.undefended_size.get(PRIMARY_LABEL).unwrap();
        def_size += s.defended_size.get(PRIMARY_LABEL).unwrap();
    }

    (def_size - undef_size) as f64 // / state.idxs.len() as f64
}

/// Remove values from the tail set that would cause the existence
/// of any set with size less than k.
fn prune_useless_values(k: usize, tail_set: &mut Vec<(usize, u64)>, state: &LocalState) {
    let len = tail_set.len();

    for i in (0..len).rev() {
        let (seg_idx, seg_size) = tail_set[i];

        for s in state.sets.iter() {
            let idxs = &s.idxs;
            let mut set_a = 0;
            let mut set_b = 0;

            for v in idxs.iter() {
                if state.videos[*v]
                    .data_segments
                    .get(PRIMARY_LABEL)
                    .unwrap()
                    .get(seg_idx)
                    .unwrap_or(&0)
                    <= &seg_size
                {
                    set_a += 1;
                } else {
                    set_b += 1;
                }
            }

            if set_a == 0 || set_b == 0 {
                continue;
            }
            if set_a < k || set_b < k {
                tail_set.remove(i);
                break;
            }
        }
    }
}

/// Put values that are more likely to result in good anonymizations
/// at the front of the tail set.
fn reorder_tail_set(tail_set: &mut Vec<(usize, u64)>, state: &LocalState) {
    tail_set.sort_by_key(|a| {
        let (seg_idx, seg_size) = a;

        // Prioritize more splits, then smaller sets.
        // It may be interesting to experiment with different ways of
        // reordering the tail set, but this seems to work fairly well.
        let mut splits: i64 = 0;
        let mut size_square: u64 = 0;

        for s in state.sets.iter() {
            let idxs = &s.idxs;
            let mut set_a: u64 = 0;
            let mut set_b: u64 = 0;

            for v in idxs.iter() {
                if state.videos[*v]
                    .data_segments
                    .get(PRIMARY_LABEL)
                    .unwrap()
                    .get(*seg_idx)
                    .unwrap_or(&0)
                    <= seg_size
                {
                    set_a += 1;
                } else {
                    set_b += 1;
                }
            }

            if set_a > 0 && set_b > 0 {
                splits += 1;
            }
            size_square += set_a.pow(2) + set_b.pow(2);
        }

        (-splits, size_square)
    });
}
