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
import Constants from '../constants/Constants.js';
import DataChunk from '../vo/DataChunk.js';
import FragmentModel from '../models/FragmentModel.js';
import FragmentLoader from '../FragmentLoader.js';
import EventBus from '../../core/EventBus.js';
import Events from '../../core/events/Events.js';
import MediaPlayerEvents from '../MediaPlayerEvents.js';
import Errors from '../../core/errors/Errors.js';
import FactoryMaker from '../../core/FactoryMaker.js';
import Debug from '../../core/Debug.js';

function FragmentController(config) {

    config = config || {};
    const context = this.context;
    const eventBus = EventBus(context).getInstance();

    const errHandler = config.errHandler;
    const mediaPlayerModel = config.mediaPlayerModel;
    const dashMetrics = config.dashMetrics;
    const debug = Debug(context).getInstance();
    const streamInfo = config.streamInfo;

    let instance,
        logger,
        fragmentModels,
        partialSegments,
        pendingInit,
        pendingMedia;

    function setup() {
        logger = debug.getLogger(instance);
        resetInitialSettings();
        eventBus.on(MediaPlayerEvents.FRAGMENT_LOADING_COMPLETED, onFragmentLoadingCompleted, instance);
        //eventBus.on(MediaPlayerEvents.FRAGMENT_LOADING_PROGRESS, onFragmentLoadingCompleted, instance);
    }

    function getStreamId() {
        return streamInfo.id;
    }

    function getModel(type) {
        let model = fragmentModels[type];
        if (!model) {
            model = FragmentModel(context).create({
                streamInfo: streamInfo,
                type: type,
                dashMetrics: dashMetrics,
                fragmentLoader: FragmentLoader(context).create({
                    dashMetrics: dashMetrics,
                    mediaPlayerModel: mediaPlayerModel,
                    errHandler: errHandler,
                    settings: config.settings,
                    boxParser: config.boxParser,
                    eventBus: eventBus,
                    events: Events,
                    errors: Errors,
                    dashConstants: config.dashConstants,
                    urlUtils: config.urlUtils,
                    streamId: getStreamId()
                }),
                debug: debug,
                eventBus: eventBus,
                events: Events
            });

            fragmentModels[type] = model;
        }

        return model;
    }

    function resetInitialSettings() {
        for (let model in fragmentModels) {
            fragmentModels[model].reset();
        }
        fragmentModels = {};
        partialSegments = [];
        pendingInit = [];
        pendingMedia = [];
    }

    function reset() {
        eventBus.off(MediaPlayerEvents.FRAGMENT_LOADING_COMPLETED, onFragmentLoadingCompleted, this);
        //eventBus.off(MediaPlayerEvents.FRAGMENT_LOADING_PROGRESS, onFragmentLoadingCompleted, this);
        resetInitialSettings();
    }

    function createDataChunk(bytes, request, streamId, endFragment) {
        const chunk = new DataChunk();

        chunk.streamId = streamId;
        chunk.segmentType = request.type;
        chunk.start = request.startTime;
        chunk.duration = request.duration;
        chunk.end = chunk.start + chunk.duration;
        chunk.bytes = bytes;
        chunk.index = request.index;
        chunk.quality = request.quality;
        chunk.representation = request.representation;
        chunk.endFragment = endFragment;

        return chunk;
    }

    // Combine partial responses with a given index and remove from the list.
    function _concatPartialSegments(index, representationId, mediaType) {
        logger.debug('Concat partial responses for segment with index ' + index + ', representation id' + representationId);

        // Pass 1: Identify relevant pieces and resource size
        let pieces = [];
        let minRangeStart = Number.MAX_SAFE_INTEGER;
        let maxRangeEnd = 0;

        for (let i = partialSegments.length - 1; i >= 0; i--) {
            const piece = partialSegments[i];

            if ((index == piece.request.index || (isNaN(index) && isNaN(piece.request.index))) && mediaType == piece.request.mediaType && representationId == piece.request.representation.id) {
                let rangeStart = 0;
                let rangeEnd = -1; // sentinel; will be resolved to an absolute byte position below

                if (piece.request.originalRange) {
                    const rangeTokens = piece.request.originalRange.split('-');

                    const ors = parseInt(rangeTokens[0], 10);
                    const ore = parseInt(rangeTokens[1], 10);
                    if (!isNaN(ors)) {
                        rangeStart = ors;
                    }
                    if (!isNaN(ore)) {
                        rangeEnd = ore;
                    }
                }

                if (piece.request.range) {
                    const rangeTokens = piece.request.range.split('-');

                    let rs = parseInt(rangeTokens[0], 10);
                    let re = parseInt(rangeTokens[1], 10);

                    if (!isNaN(rs)) {
                        rangeStart = rs;
                    }
                    if (!isNaN(re)) {
                        rangeEnd = re;
                    }
                }

                // If no explicit end byte was provided (e.g. open-ended range "44000-"),
                // derive the absolute end position from the start and the actual response size.
                if (rangeEnd < 0) {
                    rangeEnd = rangeStart + piece.response.byteLength - 1;
                }

                minRangeStart = Math.min(minRangeStart, rangeStart);
                maxRangeEnd = Math.max(maxRangeEnd, rangeEnd);
                pieces.push(piece);

                partialSegments.splice(i, 1);
            }
        }

        // Pass 2: Reassemble the pieces into one byte array
        const totalSize = maxRangeEnd - minRangeStart + 1;
        logger.debug('Found ' + pieces.length + ' partial responses (' + totalSize + ' bytes) for segment with index ' + index);

        let result = new Uint8Array(totalSize);

        for (let i = 0; i < pieces.length; i++) {
            const piece = pieces[i];
            const rangeTokens = piece.request.range ? piece.request.range.split('-') : ['0'];
            const rangeStart = parseInt(rangeTokens[0], '10');

            logger.debug('Partial response combination: rangeStart=' + rangeStart + ', byteLength=' + piece.response.byteLength);
            result.set(piece.response, rangeStart - minRangeStart);
        }

        logger.debug('Combined ' + pieces.length + ' partial responses for segment with index ' + index);

        return result;
    }

    function onFragmentLoadingCompleted(e) {
        // Event propagation may have been stopped (see MssHandler)
        if (!e.sender) {
            return;
        }

        const request = e.request;
        const bytes = e.response;
        const isInit = request.isInitializationRequest();
        const strInfo = request.representation.mediaInfo.streamInfo;

        if (e.error) {
            if (request.mediaType === Constants.AUDIO || request.mediaType === Constants.VIDEO || (request.mediaType === Constants.TEXT && request.representation.mediaInfo.isFragmented)) {
                // add service location to blacklist controller - only for audio or video. text should not set errors
                eventBus.trigger(Events.SERVICE_LOCATION_BASE_URL_BLACKLIST_ADD, { entry: e.request.serviceLocation });
            }
        }

        if (!bytes || !strInfo) {
            logger.warn('No ' + request.mediaType + ' bytes to push or stream is inactive.');
            return;
        }

        // Check if any pending events should be fired first.
        // The pending events list will be traversed from the end,
        // so make sure it is in reverse firing order.
        let primaryEvent = null;
        let secondaryEvents = [];

        if (request.buffer) {
            // [data segments]
            for (let i = pendingMedia.length - 1; i >= 0; i--) {
                const event = pendingMedia[i];

                if (event.streamId == strInfo.id && event.mediaType == request.mediaType) {
                    if (event.representationId == request.representation.id) {
                        secondaryEvents.push(event);
                    }
                    pendingMedia.splice(i, 1);
                }
            }

            // [init segments]
            for (let i = pendingInit.length - 1; i >= 0; i--) {
                const event = pendingInit[i];
                
                if (event.streamId == strInfo.id && event.mediaType == request.mediaType) {
                    secondaryEvents.push(event);
                    pendingInit.splice(i, 1);
                }
            }
        }

        // Treat all requests as partial for uniformity and simplicity.
        if (!request.padding) {
            partialSegments.push({
                request: request,
                response: new Uint8Array(bytes)
            });
        }

        // If this request completes a sequence of partial segment downloads,
        // put together the pieces we have and fire or store a loaded event.
        if (request.full) {
            const response = _concatPartialSegments(request.index, request.representation.id, request.mediaType);
            const chunk = createDataChunk(response, request, streamInfo.id, e.type !== Events.FRAGMENT_LOADING_PROGRESS);

            if (request.buffer) {
                primaryEvent = {
                    chunk: chunk,
                    event: isInit ? Events.INIT_FRAGMENT_LOADED : Events.MEDIA_FRAGMENT_LOADED,
                    index: isInit ? NaN : request.index
                };
            } else {
                if (isInit) {
                    pendingInit.push({
                        chunk: chunk,
                        streamId: strInfo.id,
                        mediaType: request.mediaType,
                        representationId: request.representation.id,
                        event: Events.INIT_FRAGMENT_LOADED,
                        index: NaN
                    });
                } else {
                    pendingMedia.push({
                        chunk: chunk,
                        streamId: strInfo.id,
                        mediaType: request.mediaType,
                        representationId: request.representation.id,
                        event: Events.MEDIA_FRAGMENT_LOADED,
                        index: request.index
                    });
                }
                primaryEvent = {
                    event: isInit ? Events.INIT_FRAGMENT_PARTIAL : Events.MEDIA_FRAGMENT_PARTIAL,
                    index: isInit ? NaN : request.index
                };
            }
        } else if (!request.padding) {
            primaryEvent = {
                event: isInit ? Events.INIT_FRAGMENT_PARTIAL : Events.MEDIA_FRAGMENT_PARTIAL,
                index: isInit ? NaN : request.index
            };
        } else {
            primaryEvent = {
                event: Events.PADDING_LOADED,
                index: request.index
            };
        }

        // Finally, fire all events in chronological order. Only the last one
        // may result in further segment downloads; the others are suppressed.
        for (let i = secondaryEvents.length - 1; i >= 0; i--) {
            const event = secondaryEvents[i];

            eventBus.trigger(event.event,
                { chunk: event.chunk, suppress: true }, // removed request, segment won't be blacklisted if appending fails
                { streamId: strInfo.id, mediaType: request.mediaType }
            );
        }

        if (primaryEvent.event == Events.INIT_FRAGMENT_LOADED || primaryEvent.event == Events.MEDIA_FRAGMENT_LOADED) {
            eventBus.trigger(primaryEvent.event,
                { chunk: primaryEvent.chunk, suppress: false }, // removed request, segment won't be blacklisted if appending fails
                { streamId: strInfo.id, mediaType: request.mediaType }
            );
        } else { // send extra data with partial events for debugging purposes
            eventBus.trigger(primaryEvent.event,
                { index: primaryEvent.index, representation: request.representation, quality: request.quality, byteLength: bytes.byteLength, trail: request.trail, buffer: request.buffer && secondaryEvents.length == 0, bufferFlag: request.buffer, suppress: false },
                { streamId: strInfo.id, mediaType: request.mediaType }
            );
        }
    }

    instance = {
        getStreamId,
        getModel,
        reset
    };

    setup();

    return instance;
}

FragmentController.__dashjs_factory_name = 'FragmentController';
export default FactoryMaker.getClassFactory(FragmentController);
