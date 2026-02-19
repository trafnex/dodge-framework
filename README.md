<img src="dodge-logo.png" width="400">

<p align="left">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/trafnex/dodge-framework/blob/master/dodge-logo-dark.png">
  <img src="https://github.com/trafnex/dodge-framework/blob/master/dodge-logo-light.png">
</picture>
</p>

## Overview

This repository contains an implementation of Dodge, a client-side framework for application-layer video fingerprinting defenses. Dodge introduces a generalization of DASH streaming, replacing video segment downloads with customizable *cycles* that are specified in a JSON *extended manifest*. In other words, Dodge supports modification of the request-response sequences of video traffic, enabling different types of traffic analysis defenses that can be provided to the video player as JSON files.

With Dodge, we provide not only a testbed for traffic analysis defenses but also a practical tool that enables defended video playback without any required changes to servers or network infrastructure. Video servers themselves could distribute defenses in the form of extended manifests (and this may be an important use case); but defenses could also be distributed by a trusted third party or in community repositories, similar to AdBlock filter lists. You could even create defenses yourself and start watching now!

Dodge is implemented as a fork of dash.js, a JavaScript implementation for the playback of MPEG-DASH content in browser-based
environments that support the [Media Source Extensions](https://w3c.github.io/media-source/) and [Encrypted Media Extensions](https://www.w3.org/TR/encrypted-media/). Our code can be used as is or as a reference when implementing defenses in other video players.

Our implementation of Dodge is in the `framework` folder. You'll also find Dodge-mimic, a proof-of-concept defense implementation, in the repository (`defenses` folder). It's based on grouping videos into anonymity sets and ensuring they have indistinguishable traffic patterns when played at the same representation(s).

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
