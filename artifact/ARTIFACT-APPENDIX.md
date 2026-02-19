# Artifact Appendix

Paper title: Dodge: A Client-Side Framework for Application-Layer Video Fingerprinting Defenses

Requested Badge(s):
  - [X] **Available**
  - [ ] **Functional**
  - [ ] **Reproduced**

## Description
This artifact is for the PoPETS 2026 paper "Dodge: A Client-Side Framework for Application-Layer Video Fingerprinting Defenses" by Ethan Witwer, David Hasselquist, Tobias Pulls, and Niklas Carlsson. It consists of three parts:
 * The Dodge framework for video fingerprinting defenses, which is the paper's primary contribution. It's a fork of the dash.js video player with support for traffic analysis defenses expressed as extended manifests (JSON files that follow a specific format). See the `framework` folder in the repository root.
 * A Rust implementation of Dodge-mimic, the proof-of-concept defense used for evaluations in the paper. The code takes a dataset of video metadata, creates anonymity sets based on similarity in sequences of segment sizes, and generates extended manifests. See the `defenses` folder in the repository root.
 * Artifact-specific inclusions: the `artifact` folder (where you are right now) with everything needed to perform a basic test of Dodge and Dodge-mimic, if desired. This consists of a minimal Flask server that serves a web page that integrates the Dodge player, for testing its functionality, and a dataset to run the defense code with.

### Security/Privacy Issues and Ethical Concerns

This artifact does not represent any security or privacy risks for the user. The Flask server hosts a web page via a loopback address (not externally accessible), and the only task to be performed on the page is to verify that a few videos play without issue. The Dodge-mimic code is implemented in Rust and simply processes a dataset and produces JSON files as output.

## Environment

### Accessibility

This artifact is available at: https://github.com/trafnex/dodge-framework/tree/master

### Set up the environment

Though not required for the Available badge, we include instructions on how to perform basic tests here. This information is also available in the README.md file in the repository root. We assume that the instructions will be followed on a Debian-based Linux machine.

Start by installing Node Package Manager, Python 3, and Flask if you want to test the Dodge framework:

```
sudo apt update
sudo apt install npm python3 python3-pip
pip3 install flask flask-cors
```

You'll also need `cargo` (Rust) if you want to test the Dodge-mimic defense code. We refer to the official Rust documentation for this step: https://rust-lang.org/tools/install/

### Testing the environment

To test Dodge's functionality, you should begin by building Dodge. Set your working directory to the `framework` folder and run these commands:

```
npm install
npm run build
```

Now, you can run the Flask server that hosts a test page with some Dodge players (corresponding to the demo linked in README.md). From the `artifact` directory:

```
python3 server.py
```

Navigate to http://localhost:5000/ and play the videos for a few seconds, and perhaps try seeking to different points in playback (but not too close to the end, in the case of the third video). If you for any reason run into issues or experience weird behavior, just reload the page and try again.

---

To test Dodge-mimic, move to the `defenses` directory and run:

```
cargo build --release
```

Then, run the following command and wait at least 30 seconds. The longer you let it run, the better the generated anonymity sets will be. However, that's not the goal here, and it will likely take a long time for the program to stop on its own, so press Ctrl-C once you feel you've waited long enough.

```
./target/release/dodge-defenses group ../artifact/dataset.json -w 8 10 > output.txt
```

Check output.txt - it contains some information regarding the anonymity sets generated at each step of the algorithm. At the bottom, you'll see overhead statistics. If you don't see any output, you need to let the program run a bit longer (you can run without piping to see output in the terminal if you don't want to guess how long you need wait). Also look at the `mfst/` directory that was created, and check out some of the extended manifests. They should have a clear JSON structure with a `start` object and `streams` list.

That's it!

## Notes on Reusability

Check out README.md for information on how Dodge can be used outside of this artifact. There are lots of potential use cases! Dodge-mimic could also be deployed in practice, but we use it only as a proof-of-concept defense and don't recommend it for real-world use.
