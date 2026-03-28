/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import FragmentRequest from '../streaming/vo/FragmentRequest.js';
import {HTTPRequest} from '../streaming/vo/metrics/HTTPRequest.js';
import FactoryMaker from '../core/FactoryMaker.js';
import MediaPlayerEvents from '../streaming/MediaPlayerEvents.js';
import {
    replaceIDForTemplate,
    replaceTokenForTemplate,
    unescapeDollarsInTemplate,
    countUnpaddedTokenOccurrences
} from './utils/SegmentsUtils.js';
import Settings from '../core/Settings.js';


const DEFAULT_ADJUST_SEEK_TIME_THRESHOLD = 0.5;
const SEGMENT_START_TIME_DELTA = 0.001;

function DashHandler(config) {

    config = config || {};

    const eventBus = config.eventBus;
    const debug = config.debug;
    const urlUtils = config.urlUtils;
    const type = config.type;
    const streamInfo = config.streamInfo;
    const defenseController = config.defenseController;
    const playbackController = config.playbackController;
    const segmentsController = config.segmentsController;
    const timelineConverter = config.timelineConverter;
    const baseURLController = config.baseURLController;

    const context = this.context;
    const settings = Settings(context).getInstance();

    let instance,
        logger,
        defendedStreamInfo,
        lastInitIndex,
        lastCycleIndex,
        lastSegment,
        isDynamicManifest,
        mediaHasFinished;

    function setup() {
        logger = debug.getLogger(instance);
        resetInitialSettings();

        eventBus.on(MediaPlayerEvents.DYNAMIC_TO_STATIC, _onDynamicToStatic, instance);
    }

    function initialize(isDynamic) {
        isDynamicManifest = isDynamic;
        mediaHasFinished = false;
        segmentsController.initialize(isDynamic);
    }

    function getStreamId() {
        return streamInfo.id;
    }

    function getType() {
        return type;
    }

    function getStreamInfo() {
        return streamInfo;
    }

    function resetInitialSettings() {
        defendedStreamInfo = null;
        lastInitIndex = -1;
        lastCycleIndex = -1;
        lastSegment = null;
    }

    function reset() {
        resetInitialSettings();
        eventBus.off(MediaPlayerEvents.DYNAMIC_TO_STATIC, _onDynamicToStatic, instance);
    }

    function _setRequestUrl(request, destination, representation, replacements = null) {
        const baseURL = baseURLController.resolve(representation.path);
        let url,
            serviceLocation,
            queryParams = {};

        if (!baseURL || (destination === baseURL.url) || (!urlUtils.isRelative(destination))) {
            url = destination;
        } else {
            url = baseURL.url;
            serviceLocation = baseURL.serviceLocation;
            queryParams = baseURL.queryParams;
            
            // add nonsense to avoid caching...
            if (queryParams == null || queryParams == undefined) {
                queryParams = {};
            }
            let random = Math.random().toString(36).substring(2, 10);

            // add padding to account for templates being filled with
            // values that have different numbers of characters
            if (replacements) {
                let max = Number.MAX_SAFE_INTEGER.toString().length;

                if (replacements['Number'] > 0) {
                    let count = replacements['Number'];
                    let chars = request.replacementNumber.toString().length;

                    random += '0'.repeat(count * (max - chars));
                }
                if (replacements['Time'] > 0) {
                    let count = replacements['Time'];
                    let chars = request.replacementTime.toString().length;

                    random += '0'.repeat(count * (max - chars));
                }
                if (replacements['Bandwidth'] > 0) {
                    let count = replacements['Bandwidth'];
                    let chars = request.representation.bandwidth.toString().length;

                    random += '0'.repeat(count * (max - chars));
                }
                if (replacements['ID'] > 0) {
                    let count = replacements['ID'];
                    let chars = request.representation.id.toString().length;
                    max = settings.get().streaming.dodge.maxIdLength;

                    random += '0'.repeat(count * (max - chars));
                }
            }

            queryParams[settings.get().streaming.dodge.queryParam] = random;

            if (destination) {
                url = urlUtils.resolve(destination, url);
            }
        }

        if (urlUtils.isRelative(url)) {
            return false;
        }

        request.url = url;
        request.serviceLocation = serviceLocation;
        request.queryParams = queryParams;

        return true;
    }


    function getInitRequest(mediaInfo, representation) {
        if (!representation || !defendedStreamInfo) {
            return null;
        }

        const initIndex = lastInitIndex + 1;
        const cycle = defendedStreamInfo['init'][initIndex];

        lastInitIndex = initIndex;
        
        let request = _generateInitRequest(mediaInfo, representation, getType(), cycle.range, cycle.padding);
        if (request) {
            request.full = getRemainingInitCycles() == 0;
            request.buffer = request.full;
        }
        return request;
    }

    function _generateInitRequest(mediaInfo, representation, mediaType, range = null, padding = false) {
        const request = new FragmentRequest();
        const period = representation.adaptation.period;
        const presentationStartTime = period.start;

        // count how many times each token will be replaced for padding
        let replacements = {
            'Bandwidth': 1,
            'Number': 0,
            'Time': 0,
            'ID': 0,
        }

        request.mediaType = mediaType;
        request.type = HTTPRequest.INIT_SEGMENT_TYPE;
        request.originalRange = representation.range;
        if (range) {
            request.range = range;
            request.partial = true; // tag for events
        } else {
            request.range = representation.range;
            request.partial = false;
        }
        if (padding) {
            request.padding = true; // discard response
        }
        request.availabilityStartTime = timelineConverter.calcAvailabilityStartTimeFromPresentationTime(presentationStartTime, representation, isDynamicManifest);
        request.availabilityEndTime = timelineConverter.calcAvailabilityEndTimeFromPresentationTime(presentationStartTime + period.duration, representation, isDynamicManifest);
        request.representation = representation;

        if (_setRequestUrl(request, representation.initialization, representation, replacements)) {
            request.url = replaceTokenForTemplate(request.url, 'Bandwidth', representation.bandwidth);
            return request;
        }
    }

    function _getRequestForSegment(mediaInfo, segment, range = null, padding = false) {
        if (segment === null || segment === undefined) {
            return null;
        }

        const request = new FragmentRequest();
        const representation = segment.representation;
        const bandwidth = representation.bandwidth;
        let url = segment.media;

        // count how many times each token will be replaced for padding
        let replacements = {
            'Number': countUnpaddedTokenOccurrences(url, 'Number'),
            'Time': countUnpaddedTokenOccurrences(url, 'Time'),
            'Bandwidth': countUnpaddedTokenOccurrences(url, 'Bandwidth'),
            'ID': (url.indexOf('$RepresentationID$') === -1) ? 0 : 1,
        }
        if (segment.replacements) {
            replacements['Number'] += segment.replacements['Number'];
            replacements['Time'] += segment.replacements['Time'];
        }

        url = replaceTokenForTemplate(url, 'Number', segment.replacementNumber);
        url = replaceTokenForTemplate(url, 'Time', segment.replacementTime);
        url = replaceTokenForTemplate(url, 'Bandwidth', bandwidth);
        url = replaceIDForTemplate(url, representation.id);
        url = unescapeDollarsInTemplate(url);

        request.mediaType = getType();
        request.bandwidth = representation.bandwidth;
        request.type = HTTPRequest.MEDIA_SEGMENT_TYPE;
        request.originalRange = segment.mediaRange;
        if (range) {
            request.range = range;
            request.partial = true; // tag for events
        } else {
            request.range = segment.mediaRange;
            request.partial = false;
        }
        if (padding) {
            request.padding = true; // discard response
        }
        request.startTime = segment.presentationStartTime;
        request.mediaStartTime = segment.mediaStartTime;
        request.duration = segment.duration;
        request.timescale = representation.timescale;
        request.availabilityStartTime = segment.availabilityStartTime;
        request.availabilityEndTime = segment.availabilityEndTime;
        request.availabilityTimeComplete = representation.availabilityTimeComplete;
        request.wallStartTime = segment.wallStartTime;
        request.index = segment.index;
        request.adaptationIndex = representation.adaptation.index;
        request.representation = representation;
        request.replacementNumber = segment.replacementNumber;
        request.replacementTime = segment.replacementTime;

        if (_setRequestUrl(request, url, representation, replacements)) {
            return request;
        }
    }

    function isLastSegmentRequested(representation, bufferingTime) {
        if (!representation || !lastSegment || lastCycleIndex < 0) {
            return false;
        }

        // No next cycle found
        if (mediaHasFinished) {
            return true;
        }

        // We are replacing existing stuff in the buffer for instance after a track switch
        if (lastSegment.presentationStartTime + lastSegment.duration > bufferingTime) {
            return false;
        }

        // Check if any more cycles are specified in the defended stream info that is in use
        if (defendedStreamInfo && lastCycleIndex >= defendedStreamInfo['data'].length - 1) {
            return true;
        }

        return false;
    }


    function getSegmentRequestForTime(mediaInfo, representation, time) {
        // If we are trailing and a spurious seek occurs (it shouldn't),
        // ignore it. But if the user seeks - at least one segment before
        // the end of the stream - allow it.
        if (playbackController.getTimeSinceStreamEnd() > 0 && playbackController.getStreamEndTime(representation.mediaInfo.streamInfo) - time < representation.segmentDuration) {
            return getNextSegmentRequest(mediaInfo, representation);
        }
        let request = null;

        if (!representation || !representation.segmentInfoType || !defendedStreamInfo) {
            return request;
        }

        // start with segment
        const segment = segmentsController.getSegmentByTime(representation, time);
        if (!segment) {
            logger.debug('No segment found for time ' + time);
            return request;
        } else {
            logger.debug('Index for time ' + time + ' is ' + segment.index);
        }
        
        // find first cycle containing the desired segment
        // construct a request based on that cycle's fields
        const cycleIndex = defenseController.getCycleIndexBySegmentIndex(defendedStreamInfo, segment.index);
        const cycle = defendedStreamInfo['data'][cycleIndex];
        if (!cycle) {
            return null;
        }
        logger.debug('cycle ' + cycleIndex + '/' + defendedStreamInfo['data'].length);

        // determine if full request
        let nextIndex = cycleIndex + 1;
        let nextCycle = defendedStreamInfo['data'][nextIndex];

        while (nextCycle && nextCycle.padding) {
            nextIndex += 1;
            nextCycle = defendedStreamInfo['data'][nextIndex];
        }

        // update invariants
        lastCycleIndex = cycleIndex;
        lastSegment = segment;

        request = _getRequestForSegment(mediaInfo, segment, cycle.range, cycle.padding);
        if (request) {
            request.full = !cycle.padding && (!nextCycle || nextCycle.index != cycle.index);
            request.buffer = cycle.buffer;
            request.trail = cycleIndex > defendedStreamInfo['maxNoPad'];
        }
        return request;
    }

    /**
     * Main function to get the next segment request.
     * @param {object} mediaInfo
     * @param {object} representation
     * @return {FragmentRequest|null}
     */
    function getNextSegmentRequest(mediaInfo, representation) {
        let request = null;

        if (!representation || !representation.segmentInfoType || !defendedStreamInfo) {
            return request;
        }

        // start with cycle
        const cycleIndex = lastCycleIndex + 1;
        
        const cycle = defendedStreamInfo['data'][cycleIndex];
        if (!cycle) {
            logger.debug('No cycle found with index ' + cycleIndex);
            mediaHasFinished = true;
            return request;
        }

        // continue with segment
        const segment = (lastSegment && cycle.index == lastSegment.index) ? lastSegment : segmentsController.getSegmentByIndex(representation, cycle.index, -1);
        if (!segment) {
            logger.debug('No segment found, lastSegment = ' + !!lastSegment);
            return request;
        }
        logger.debug('cycle ' + cycleIndex + '/' + defendedStreamInfo['data'].length);

        // determine if full request
        let nextIndex = cycleIndex + 1;
        let nextCycle = defendedStreamInfo['data'][nextIndex];

        while (nextCycle && nextCycle.padding) {
            nextIndex += 1;
            nextCycle = defendedStreamInfo['data'][nextIndex];
        }

        // update invariants
        lastCycleIndex = cycleIndex;
        if (!cycle.padding) {
            lastSegment = segment;
        }

        request = _getRequestForSegment(mediaInfo, segment, cycle.range, cycle.padding);
        if (request) {
            request.full = !cycle.padding && (!nextCycle || nextCycle.index != cycle.index);
            request.buffer = cycle.buffer;
            request.trail = cycleIndex > defendedStreamInfo['maxNoPad'];
        }
        return request;
    }

    function repeatSegmentRequest(mediaInfo, representation) {
        return getSegmentRequestForTime(mediaInfo, representation, lastSegment.presentationStartTime);
    }

    /**
     * This function returns a time larger than the current time for which we can generate a request.
     * This is useful in scenarios in which the user seeks into a gap in a dynamic Timeline manifest. We will not find a valid request then and need to adjust the seektime.
     * @param {number} time
     * @param {object} mediaInfo
     * @param {object} representation
     * @param {number} targetThreshold
     * @return {number}
     */
    function getValidTimeAheadOfTargetTime(time, mediaInfo, representation, targetThreshold) {
        // Save cycle state — the getSegmentRequestForTime calls below are exploratory
        // and must not permanently advance lastCycleIndex/lastSegment.
        const savedCycleIndex = lastCycleIndex;
        const savedSegment = lastSegment;
        try {

            if (isNaN(time) || !mediaInfo || !representation) {
                return NaN;
            }

            if (time < 0) {
                time = 0;
            }

            if (isNaN(targetThreshold)) {
                targetThreshold = DEFAULT_ADJUST_SEEK_TIME_THRESHOLD;
            }

            if (getSegmentRequestForTime(mediaInfo, representation, time)) {
                return time;
            }

            if (representation.adaptation.period.start + representation.adaptation.period.duration < time) {
                return NaN;
            }

            // If we have a duration look until the end of the duration, otherwise maximum 30 seconds
            const end = isFinite(representation.adaptation.period.duration) ? representation.adaptation.period.start + representation.adaptation.period.duration : time + 30;
            let currentUpperTime = Math.min(time + targetThreshold, end);
            let adjustedTime = NaN;
            let targetRequest = null;

            while (currentUpperTime <= end) {
                let upperRequest = null;

                if (currentUpperTime <= end) {
                    upperRequest = getSegmentRequestForTime(mediaInfo, representation, currentUpperTime);
                }

                if (upperRequest) {
                    adjustedTime = currentUpperTime;
                    targetRequest = upperRequest;
                    break;
                }

                currentUpperTime += targetThreshold;
            }

            if (targetRequest) {
                const requestEndTime = targetRequest.startTime + targetRequest.duration;

                // Keep the original start time in case it is covered by a segment
                if (time > targetRequest.startTime && requestEndTime - time > targetThreshold) {
                    return time;
                }

                if (!isNaN(targetRequest.startTime) && time < targetRequest.startTime && adjustedTime > targetRequest.startTime) {
                    // Apply delta to segment start time to get around rounding issues
                    return targetRequest.startTime + SEGMENT_START_TIME_DELTA;
                }

                return Math.min(requestEndTime - targetThreshold, adjustedTime);
            }

            return adjustedTime;

        } catch (e) {
            return NaN;
        } finally {
            lastCycleIndex = savedCycleIndex;
            lastSegment = savedSegment;
        }
    }

    function getCurrentIndex() {
        return lastSegment ? lastSegment.index : -1;
    }

    // Which index may come next? 0 if no defended stream info.
    function getNextExpectedIndex() {
        const cycleIndex = lastCycleIndex + 1;
        const cycle = defendedStreamInfo ? defendedStreamInfo['data'][cycleIndex] : null;

        if (cycle) {
            return cycle.index;
        }

        return 0;
    }

    // How many init cycles are remaining? -1 if no defended stream info.
    function getRemainingInitCycles() {
        return defendedStreamInfo ? defendedStreamInfo['init'].length - lastInitIndex - 1 : -1;
    }

    // Update defended stream info based on the current representation info.
    function updateDefendedStreamInfo(representation) {
        const period = representation.adaptation.period.index;
        const adaptation = representation.adaptation.index;
        const quality = representation.index;

        // Get the correct label based on adaptation set and quality.
        const label = representation.id;

        // Get the defended stream info for the label determined above.
        defendedStreamInfo = defenseController.getDefendedStreamInfo(label); // streamInfo.id
        
        // Log whether defended stream info was set or not.
        if (defendedStreamInfo) {
            logger.debug('Defended stream info set for label=' + label + ', period=' + period + ', adaptation=' + adaptation + ', quality=' + quality);
        } else {
            logger.debug('Defended stream info not found for label=' + label + ', period=' + period + ', adaptation=' + adaptation + ', quality=' + quality);
        }

        return !!defendedStreamInfo;
    }

    // Do we have cycles remaining after all playable video content?
    function getIsTrailing() {
        let trailing = defendedStreamInfo && lastCycleIndex >= defendedStreamInfo['maxNoPad'] && lastCycleIndex < defendedStreamInfo['data'].length - 1;
        logger.debug('getIsTrailing() = ' + trailing);
        return trailing;
    }

    function _onDynamicToStatic() {
        logger.debug('Dynamic stream complete');
        //mediaHasFinished = true;
    }

    instance = {
        getIsTrailing,
        getCurrentIndex,
        getNextExpectedIndex,
        getRemainingInitCycles,
        updateDefendedStreamInfo,
        getInitRequest,
        getNextSegmentRequest,
        getSegmentRequestForTime,
        getStreamId,
        getStreamInfo,
        getType,
        getValidTimeAheadOfTargetTime,
        initialize,
        isLastSegmentRequested,
        repeatSegmentRequest,
        reset,
    };

    setup();

    return instance;
}

DashHandler.__dashjs_factory_name = 'DashHandler';
export default FactoryMaker.getClassFactory(DashHandler);
