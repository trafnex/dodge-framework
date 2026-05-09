<p align="left">
<picture width="400">
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/trafnex/dodge-framework/blob/master/dodge-logo-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://github.com/trafnex/dodge-framework/blob/master/dodge-logo-light.png">
  <img src="https://github.com/trafnex/dodge-framework/blob/master/dodge-logo-light.png" width="400">
</picture>
</p>

**NOTE:** This repository has been archived. Dodge has been re-implemented as a standalone, opt-in module - with production-ready improvements and a few new features - that is planned for inclusion in dash.js v5.3.0. It has also been licensed to the DASH Industry Forum (transfer document [here](https://groups.google.com/g/dashjs/c/E5anNvjRRrA)). See [PR #5021](https://github.com/Dash-Industry-Forum/dash.js/pull/5021).

For the latest information about Dodge and related tools, see [dodge.video](https://dodge.video/).

## Overview

This repository contains an implementation of Dodge, a client-side framework for application-layer video fingerprinting defenses. Dodge introduces a generalization of DASH streaming, replacing video segment downloads with customizable *cycles* that are specified in a JSON *extended manifest*. In this way, Dodge provides full control over the request-response sequences of video traffic, enabling different types of traffic analysis defenses that can be provided to the video player as JSON files.

With Dodge, we provide not only a testbed for traffic analysis defenses but also a practical tool that enables defended video playback without any required changes to servers or network infrastructure. Video servers themselves could distribute defenses in the form of extended manifests (and this may be an important use case); but defenses could also be distributed by a trusted third party or in community repositories, similar to AdBlock filter lists. You could even create defenses yourself and start watching now!

Dodge is implemented as a fork of dash.js, a JavaScript implementation for the playback of MPEG-DASH content in browser-based
environments that support the [Media Source Extensions](https://w3c.github.io/media-source/) and [Encrypted Media Extensions](https://www.w3.org/TR/encrypted-media/). Our code can be used as is or as a reference when implementing defenses in other video players.

Our implementation of Dodge is in the `framework` folder. You'll also find Dodge-mimic, a proof-of-concept defense implementation, in the repository (`defenses` folder). It's based on grouping videos into anonymity sets and ensuring they have indistinguishable traffic patterns when played at the same representation(s).

## Repository Structure

### `framework/`

A fork of dash.js v5.0.0. Only Dodge-specific files are listed below; everything else follows the upstream dash.js structure documented at [dashif.org/dash.js](https://dashif.org/dash.js/).

**Extended manifest loading**
- `src/streaming/controllers/DefenseController.js` *(new)* - stores and validates extended manifests, provides defended stream info and cycle lookup
- `src/streaming/ManifestLoader.js` - detects extended manifests (instead of MPDs), passes them to `DefenseController`, and extracts the embedded MPD and base URI

**Cycle scheduling and requests**
- `src/dash/DashHandler.js` - generates cycle-based requests from defended stream info instead of standard segment requests, marks requests as `partial` or `padding`, tracks `lastCycleIndex` and remaining init cycles
- `src/dash/utils/SegmentsUtils.js` - reports token counts in segment URLs to support URL padding during request generation
- `src/dash/utils/TemplateSegmentsGetter.js` - reports token counts in segment URLs to support URL padding during request generation
- `src/streaming/controllers/ScheduleController.js` - uses remaining init cycles from `DashHandler` to determine when the init segment download sequence is complete

**Cycle downloading and combination**
- `src/streaming/controllers/FragmentController.js` - accumulates partial segment downloads (multiple range requests per segment) and combines them into a single complete segment, discards padding responses
- `src/streaming/net/FetchLoader.js` - pads requests with a query parameter or custom header
- `src/streaming/net/XHRLoader.js` - same request padding as `FetchLoader.js`, applied to XHR-based requests

**Buffer and playback management**
- `src/streaming/StreamProcessor.js` - listens for `PADDING_LOADED`, `INIT_FRAGMENT_PARTIAL`, and `MEDIA_FRAGMENT_PARTIAL` events, handles random walk scheduling delay between cycles, and blocks buffer completion during trailing
- `src/streaming/controllers/BufferController.js` - handles mock buffer updates every time segment data is downloaded or the buffer level is updated
- `src/streaming/SourceBufferSink.js` - measures the actual buffered duration to support precise mock buffer updates throughout playback
- `src/streaming/controllers/GapController.js` - modified to prevent spurious gaps when trailing
- `src/streaming/controllers/PlaybackController.js` - measures time since playback end when trailing
- `src/streaming/MediaPlayer.js` - added a public function to get time since end of playback when trailing cycles are present in an extended manifest

**Events and settings**
- `src/core/events/CoreEvents.js` - added `PADDING_LOADED`, `INIT_FRAGMENT_PARTIAL`, and `MEDIA_FRAGMENT_PARTIAL` events
- `src/core/Settings.js` - added Dodge-related settings

### `defenses/`

Rust CLI for computing Dodge-mimic anonymity sets.

- `src/main.rs` - CLI entry point, defines the `group` subcommand, loads the dataset JSON, sorts videos by length, and dispatches to the set generation algorithm
- `src/common.rs` - shared types and defense constants
- `src/group.rs` - Dodge-mimic implementation

### `artifact/`

Demo and testing infrastructure.

- `test.html` - Three-player demo page: undefended playback, constant-size defense, and mimicry defense
- `server.py` - Flask server that serves `test.html` at `http://localhost:5000/` (with CORS enabled)
- `bbb_30fps_undef.exmfst.json` - extended manifest for Big Buck Bunny with no defense (one cycle per segment)
- `bbb_30fps_constant.exmfst.json` - extended manifest for Big Buck Bunny with a constant-size defense (all cycles the same size)
- `elephants_dream_mimicry.exmfst.json` - extended manifest for Elephants Dream with a rudimentary mimicry defense (not Dodge-mimic)
- `dataset.json` - video dataset (segment sizes and ETags per representation) that can be used as input to the `defenses` CLI
- `ARTIFACT-APPENDIX.md` - setup and testing instructions: environment setup, build steps, and test procedures for both `framework` and `defenses`

## Documentation

See the PoPETS 2026 paper "Dodge: A Client-Side Framework for Application-Layer Video Fingerprinting Defenses" ([link](https://www.ethanwitwer.com/assets/pdf/2026-pets2.pdf)) for further details on the Dodge framework, defense design, and the proof-of-concept defense used for evaluation.

If you use Dodge in your research, please cite the paper. And if you're interested in or planning to do research or development related to Dodge, feel free to contact us! You can find our contact information in the paper.

To get started with dash.js development in general, check out their [documentation](https://dashif.org/dash.js/) that includes
a [quickstart guide](https://dashif.org/dash.js/pages/quickstart/index.html), [usage instructions](https://dashif.org/dash.js/pages/usage/index.html),
and [contribution guidelines](https://dashif.org/dash.js/pages/developers/how-to-contribute.html).

## Hosted Examples

We've published a [basic demo](https://www.ethanwitwer.com/demos/dodge/) of Dodge that you can take a look at. It includes three examples of extended manifests:

* Big Buck Bunny (a common test video) without any defense; that is, an extended manifest with one cycle per segment
* Big Buck Bunny with a (rather inefficient) constant-size defense: each cycle within a representation has the same size
* Elpehants Dream with a mimicry defense, capturing the general idea of Dodge-mimic without as comprehensive protection

## Getting Started

A basic example of how to use Dodge in your application can be found below:

```html
<!doctype html>
<html>
<head>
    <title>Hello World, Goodbye Video Fingerprinting</title>
    <style>
        video {
            width: 640px;
            height: 360px;
        }
    </style>
</head>
<body>
<div>
    <video id="videoPlayer" controls></video>
</div>
<script src="./dash.all.min.js"></script>
<script>
    (function () {
        var url = "./bbb_30fps_constant.exmfst.json";
        var player = dashjs.MediaPlayer().create();
        player.initialize(document.querySelector("#videoPlayer"), url, true);
    })();
</script>
</body>
</html>
```

## Contact

Please raise any issue specific to Dodge directly on our [GitHub issue page](https://github.com/trafnex/dodge-framework/issues).

Please raise any issue related to dash.js in general directly on their [GitHub issue page](https://github.com/Dash-Industry-Forum/dash.js/issues). You can also find dash.js developers/maintainers on [Slack!](https://join.slack.com/t/dashif/shared_invite/zt-egme869x-JH~UPUuLoKJB26fw7wj3Gg) and
[Google Groups](https://groups.google.com/g/dashjs).

## License

dash.js is released under a BSD License; see the [LICENSE file](https://github.com/trafnex/dodge-framework/blob/master/framework/LICENSE.md) in the `framework` folder of this repository.

All contributions, additions, and changes to dash.js (that is, the implementation of Dodge) are available under the BSD 3-Clause License. Defense code (every file in the `defenses` folder) is similarly licensed under the BSD 3-Clause License. See the [LICENSE file](https://github.com/trafnex/dodge-framework/blob/master/LICENSE.md) in the root of the repository for further details.

Dodge is not affiliated with or endorsed by the Dash Industry Forum or dash.js contributors.
