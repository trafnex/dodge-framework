use std::fs::File;

use clap::{Parser, Subcommand};

pub mod common;
pub mod group;

use crate::common::{Video, PRIMARY_LABEL};
use crate::group::defend as group_defend;


#[derive(Parser)]
#[command(name = "dodge-defenses", version = "1.0")]
#[command(about = "Defenses for the Dodge framework.", long_about = None)]
struct Args {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Compute optimal anonymity sets for a dataset of videos.
    Group {
        /// Path to dataset JSON
        path: String,

        /// Target anonymity set size
        k: usize,

        /// Best cost seed for algorithm
        #[arg(short = 's', long = "seed")]
        seed: Option<f64>,

        /// Number of worker threads
        #[arg(short = 'w', long = "workers", default_value_t = 1)]
        workers: usize,
    },
}


fn main() {
    let args = Args::parse();

    match &args.command {
        Commands::Group {
            path,
            k,
            seed,
            workers,
        } => {
            let mut videos: Vec<Video>;
            {
                let file = File::open(path).expect("main(): failed to open dataset file");
                videos =
                    serde_json::from_reader(file).expect("main(): failed to parse dataset file");
            }
            videos.sort_by_key(|video| video.data_segments.get(PRIMARY_LABEL).unwrap().len());

            group_defend(*k, *seed, videos, *workers);
        }
    }
}
