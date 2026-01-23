<img src="dodge-logo.png" width="400">

## Overview

This repository contains an implementation of Dodge, a client-side framework for application-layer video fingerprinting defenses. Dodge introduces a generalization of DASH streaming, replacing video segment downloads with customizable *cycles* that are specified in a JSON *extended manifest*. In other words, Dodge supports different types of traffic analysis defenses, based on modifying the request-response sequences of video traffic, that can be provided to the video player as a JSON file.

With Dodge, we provide not only a testbed for traffic analysis defenses but also a practical tool that enables defended video playback without any special requirements on servers or network infrastructure. Video servers themselves could distribute defenses in the form of extended manifests (and this may be an important use case); but defenses could also be distributed by a trusted third party or in community repositories, similar to AdBlock lists. You could even create defenses yourself and start watching now!

Dodge is implemented as a fork of dash.js, a JavaScript implementation for the playback of MPEG-DASH content in browser-based
environments that support the [Media Source Extensions](https://w3c.github.io/media-source/) and [Encrypted Media Extensions](https://www.w3.org/TR/encrypted-media/).

## Documentation

See the paper "Dodge: A Client-Side Framework for Application-Layer Video Fingerprinting Defenses" in PoPETS 2026 for further details on the Dodge framework, defense design, and a proof-of-concept defense used for evaluation. If you want to do research or development related to Dodge, feel free to contact us!

To get started with dash.js development in general, check out their [documentation](https://dashif.org/dash.js/) that includes
a [quickstart guide](https://dashif.org/dash.js/pages/quickstart/index.html), [usage instructions](https://dashif.org/dash.js/pages/usage/index.html),
and [contribution guidelines](https://dashif.org/dash.js/pages/developers/how-to-contribute.html).

## Hosted Examples

TODO - add demo link, these are vanilla dash.js

* [Reference Player](https://reference.dashif.org/dash.js/latest/samples/dash-if-reference-player/index.html)
* [Samples](https://reference.dashif.org/dash.js/latest/samples/index.html)

## Quickstart

TODO - add demo extended manifest and test this

A basic example of how to use Dodge in your application can be found below:

```html
<!doctype html>
<html>
<head>
    <title>Dodge Rocks</title>
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
<script src="https://cdn.dashjs.org/latest/dash.all.min.js"></script>
<script>
    (function () {
        var url = "https://dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd";
        var player = dashjs.MediaPlayer().create();
        player.initialize(document.querySelector("#videoPlayer"), url, true);
    })();
</script>
</body>
</html>
```

## Contact

TODO - test all links

Please raise any issue specific to Dodge directly on our [GitHub issue page](https://github.com/trafnex/dodge-framework/issues).

Please raise any issue related to dash.js in general directly on their [GitHub issue page](https://github.com/Dash-Industry-Forum/dash.js/issues). You can also find dash.js developers/maintainers on [Slack!](https://join.slack.com/t/dashif/shared_invite/zt-egme869x-JH~UPUuLoKJB26fw7wj3Gg) and
[Google Groups](https://groups.google.com/g/dashjs).

## License

dash.js is released under a BSD License; see the [LICENSE file](https://github.com/trafnex/dodge-framework/blob/master/LICENSE.md) in this repository.

All contributions, additions, and changes to dash.js (the implementation of Dodge) found in this repository are available under the BSD 3-Clause License. See the [NOTICE file](https://github.com/trafnex/dodge-framework/blob/master/NOTICE.md) for further details.
