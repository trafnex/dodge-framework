/**
 * This file (and all contributions, additions, and changes to dash.js found
 * in the commit history for the GitHub repository trafnex/dodge-framework):
 *
 * Copyright (c) 2025, Ethan Witwer.
 * All rights reserved.
 *
 * dash.js is licensed under a BSD License.
 * Contributions are licensed under the BSD 3-Clause License.
 * See LICENSE.md and NOTICE.md for further details.
 */

import Debug from '../../core/Debug.js';
import FactoryMaker from '../../core/FactoryMaker.js';

function DefenseController() {

    const context = this.context;
  
    let instance,
        logger,
        manifestData = [];

    // Start listening for defense-related events.
    function setup() {
        logger = Debug(context).getInstance().getLogger(instance);
    }

    // Discard all manifest data currently stored.
    function reset() {
        manifestData = [];
    }

    // Add an extended manifest.
    // Returns true if the extended manifest was added or false if it was rejected.
    function addExtendedManifest(content, streamId = null) {
        // Validate the extended manifest.
        if (!isValidExtendedManifest(content, logger)) {
            return false;
        }

        // Each extended manifest receives a unique ID.
        content['manifestId'] = manifestData.length;
        content['streamId'] = streamId;

        // Add the extended manifest to the list of manifest data.
        logger.info('Extended manifest accepted, streamId=' + streamId);
        manifestData.push(content);

        return true;
    }

    // Get the defended stream info for a given label.
    function getDefendedStreamInfo(label, streamId = null) {
        for (let i = 0; i < manifestData.length; i++) {
            const manifest = manifestData[i];

            if (streamId && streamId != manifest['streamId']) {
                continue;
            }

            for (let j = 0; j < manifest['streams'].length; j++) {
                const stream = manifest['streams'][j];

                if (label === stream['label']) {
                    return stream;
                }
            }
        }

        return null;
    }

    // Get the first cycle index corresponding to a given segment, or -1.
    function getCycleIndexBySegmentIndex(stream, segmentIndex) {
        const data = stream['data'];

        for (let i = 0; i < data.length; i++) {
            if (segmentIndex == data[i].index && !data[i].padding) {
                return i;
            }
        }

        return -1;
    }

    // Get the cycle index corresponding to a given point in time, or -1.
    function getCycleIndexByPlaybackTime(stream, playbackTime, segmentDuration) {
        const segmentIndex = Math.floor(playbackTime / segmentDuration);
        return getCycleIndexBySegmentIndex(stream, segmentIndex);
    }

    instance = {
        addExtendedManifest,
        getDefendedStreamInfo,
        getCycleIndexBySegmentIndex,
        getCycleIndexByPlaybackTime,
        reset,
        setup
    };

    setup();

    return instance;
}

function checkInitCycles(stream, logger) {
    for (let i = 0; i < stream['init'].length; i++) {
        const range = stream['init'][i].range;

        // The range, if defined, MUST have the syntax <start>-<end>, where one of <start> and
        // <end> can be omitted. <start> MUST be less than <end> (implicitly or explicitly).
        let rs = 0;
        let re = Number.MAX_SAFE_INTEGER;

        if (range) {
            if (typeof range !== 'string' && !(range instanceof String)) {
                if (logger) {
                    logger.warn('Extended manifest rejected: defended stream info with label=' + stream['label'] + ', init cycle at index=' + i + ', invalid range');
                }
                return false;
            }

            const rangeTokens = range.split('-');
            // exactly two numerical byte indices
            if (rangeTokens.length != 2 || isNaN(rangeTokens[0]) || isNaN(rangeTokens[1])) {
                if (logger) {
                    logger.warn('Extended manifest rejected: defended stream info with label=' + stream['label'] + ', init cycle at index=' + i + ', invalid range');
                }
                return false;
            }
            rs = parseInt(rangeTokens[0], '10');
            re = parseInt(rangeTokens[1], '10');
            if (isNaN(rs)) {
                rs = 0;
            }
            if (isNaN(re)) {
                re = Number.MAX_SAFE_INTEGER;
            }
            
            // start cannot be greater than end
            if (rs > re) {
                if (logger) {
                    logger.warn('Extended manifest rejected: defended stream info with label=' + stream['label'] + ', init cycle at index=' + i + ', invalid range');
                }
                return false;
            }
        }
    }

    return true;
}

function checkDataCycles(stream, logger) {
    let rangeEnd = -1; // end of current partial segment range
    let maxIndex = -1; // maximum segment index encountered so far
    let maxNoPad = -1; // maximum non-padding cycle index found

    for (let i = 0; i < stream['data'].length; i++) {
        const index = stream['data'][i].index;
        const range = stream['data'][i].range;
        const padding = stream['data'][i].padding;

        // A data cycle MUST contain a valid segment index.
        if (isNaN(index) || index < 0) {
            if (logger) {
                logger.warn('Extended manifest rejected: defended stream info with label=' + stream['label'] + ', data cycle at index=' + i + ', invalid index');
            }
            return false;
        }

        // Segments MUST be requested sequentially: no cycle can contain a segment index
        // less than any previous one. This does not apply to padding cycles.
        if (!padding) {
            if (maxIndex >= 0 && ((rangeEnd == -1 && index <= maxIndex) || (rangeEnd >= 0 && index < maxIndex))) {
                if (logger) {
                    logger.warn('Extended manifest rejected: defended stream info with label=' + stream['label'] + ', data cycle at index=' + i + ', non-sequential index');
                }
                return false;
            }

            if (index > maxIndex) {
                rangeEnd = -1;
                maxIndex = index;
            }

            maxNoPad = i;
        }

        // The range, if defined, MUST have the syntax <start>-<end>, where one of <start> and
        // <end> can be omitted. <start> MUST be less than <end> (implicitly or explicitly).
        let rs = 0;
        let re = Number.MAX_SAFE_INTEGER;

        if (range) {
            if (typeof range !== 'string' && !(range instanceof String)) {
                if (logger) {
                    logger.warn('Extended manifest rejected: defended stream info with label=' + stream['label'] + ', data cycle at index=' + i + ', invalid range');
                }
                return false;
            }

            const rangeTokens = range.split('-');
            // exactly two numerical byte indices
            if (rangeTokens.length != 2 || isNaN(rangeTokens[0]) || isNaN(rangeTokens[1])) {
                if (logger) {
                    logger.warn('Extended manifest rejected: defended stream info with label=' + stream['label'] + ', data cycle at index=' + i + ', invalid range');
                }
                return false;
            }
            rs = parseInt(rangeTokens[0], '10');
            re = parseInt(rangeTokens[1], '10');
            if (isNaN(rs)) {
                rs = 0;
            }
            if (isNaN(re)) {
                re = Number.MAX_SAFE_INTEGER;
            }
            
            // start cannot be greater than end
            if (rs > re) {
                if (logger) {
                    logger.warn('Extended manifest rejected: defended stream info with label=' + stream['label'] + ', data cycle at index=' + i + ', invalid range');
                }
                return false;
            }
        }

        if (!padding) {
            // Cycles representing partial segment downloads (with range specified) for
            // the same segment MUST have sequential ranges with <start> = 0.
            if (rangeEnd < 0 && rs != 0) {
                if (logger) {
                    logger.warn('Extended manifest rejected: defended stream info with label=' + stream['label'] + ', data cycle at index=' + i + ', partial with no first byte');
                }
                return false;
            }

            if (rangeEnd >= 0 && rs > rangeEnd + 1) {
                if (logger) {
                    logger.warn('Extended manifest rejected: defended stream info with label=' + stream['label'] + ', data cycle at index=' + i + ', partial with non-sequential range ' + rs + '-' + re + ' (segment ' + index + ') rangeEnd=' + rangeEnd);
                }
                return false;
            }

            rangeEnd = re;
        }
    }

    stream.maxNoPad = maxNoPad;

    return true;
}

function isValidExtendedManifest(manifest, logger) {
    if (!manifest) {
        if (logger) {
            logger.warn('Extended manifest rejected: null');
        }
        return false;
    }

    // An extended manifest MUST contain the start object.
    if (!manifest['start']) {
        if (logger) {
            logger.warn('Extended manifest rejected: no start data');
        }
        return false;
    }

    // An extended manifest MUST contain the video's original MPD.
    if (typeof manifest['start']['mpd'] !== 'string' && !(manifest['start']['mpd'] instanceof String)) {
        if (logger) {
            logger.warn('Extended manifest rejected: incomplete start data, missing mpd');
        }
        return false;
    }

    // An extended manifest MUST contain a base URI for segments.
    if (typeof manifest['start']['base_uri'] !== 'string' && !(manifest['start']['base_uri'] instanceof String)) {
        if (logger) {
            logger.warn('Extended manifest rejected: incomplete start data, missing base URI');
        }
        return false;
    }

    // An extended manifest MUST contain defended stream info.
    if (!manifest['streams']) {
        if (logger) {
            logger.warn('Extended manifest rejected: no defended stream info');
        }
        return false;
    }

    // [check the list of objects containing defended stream info]
    for (let i = 0; i < manifest['streams'].length; i++) {
        const stream = manifest['streams'][i];

        // Defended stream info MUST be labeled with an adaptation set and quality.
        if (typeof stream['label'] !== 'string' && !(stream['label'] instanceof String)) {
            if (logger) {
                logger.warn('Extended manifest rejected: defended stream info at index=' + i + ', missing label');
            }
            return false;
        }

        // Defended stream info MUST contain at least one init cycle.
        if (!stream['init'] || stream['init'].length == 0) {
            if (logger) {
                logger.warn('Extended manifest rejected: defended stream info with label=' + stream['label'] + ', missing init cycles');
            }
            return false;
        }

        // Defended stream info MUST contain at least one data cycle.
        if (!stream['data'] || stream['data'].length == 0) {
            if (logger) {
                logger.warn('Extended manifest rejected: defended stream info with label=' + stream['label'] + ', missing data cycles');
            }
            return false;
        }

        // [check init cycles]
        //if (!checkInitCycles(stream, logger)) {
        //    return false;
        //}
        checkInitCycles(stream, logger);

        // [check data cycles]
        //if (!checkDataCycles(stream, logger)) {
        //    return false;
        //}
        checkDataCycles(stream, logger);
    }

    return true;
}

DefenseController.__dashjs_factory_name = 'DefenseController';
export default FactoryMaker.getSingletonFactory(DefenseController);
export {isValidExtendedManifest};
