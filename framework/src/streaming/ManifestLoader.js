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
import Constants from './constants/Constants.js';
import DashConstants from '../dash/constants/DashConstants.js';
import XlinkController from './controllers/XlinkController.js';
import URLLoader from './net/URLLoader.js';
import URLUtils from './utils/URLUtils.js';
import TextRequest from './vo/TextRequest.js';
import DashJSError from './vo/DashJSError.js';
import {HTTPRequest} from './vo/metrics/HTTPRequest.js';
import EventBus from '../core/EventBus.js';
import Events from '../core/events/Events.js';
import Errors from '../core/errors/Errors.js';
import FactoryMaker from '../core/FactoryMaker.js';
import DashParser from '../dash/parser/DashParser.js';
import DefenseController from './controllers/DefenseController.js'

function ManifestLoader(config) {

    config = config || {};
    const context = this.context;
    const debug = config.debug;
    const settings = config.settings;
    const eventBus = EventBus(context).getInstance();
    const urlUtils = URLUtils(context).getInstance();
    const defenseController = DefenseController(context).getInstance();

    let instance,
        logger,
        urlLoader,
        xlinkController,
        parser;

    let mssHandler = config.mssHandler;
    let errHandler = config.errHandler;

    function setup() {
        logger = debug.getLogger(instance);
        eventBus.on(Events.XLINK_READY, onXlinkReady, instance);

        urlLoader = URLLoader(context).create({
            errHandler: config.errHandler,
            dashMetrics: config.dashMetrics,
            mediaPlayerModel: config.mediaPlayerModel,
            urlUtils: urlUtils,
            constants: Constants,
            dashConstants: DashConstants,
            errors: Errors,
            requestTimeout: config.settings.get().streaming.manifestRequestTimeout
        });

        xlinkController = XlinkController(context).create({
            errHandler: errHandler,
            dashMetrics: config.dashMetrics,
            mediaPlayerModel: config.mediaPlayerModel,
            settings: config.settings
        });

        parser = null;
    }

    function onXlinkReady(event) {
        eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, { manifest: event.manifest });
    }

    function createParser(data) {
        let parser = null;
        // Analyze manifest content to detect protocol and select appropriate parser
        if (data.indexOf('SmoothStreamingMedia') > -1) {
            //do some business to transform it into a Dash Manifest
            if (mssHandler) {
                parser = mssHandler.createMssParser();
                mssHandler.createMssFragmentProcessor();
                mssHandler.registerEvents();
            }
            return parser;
        } else if (data.indexOf('MPD') > -1 || data.indexOf('Patch') > -1) {
            return DashParser(context).create({ debug: debug });
        } else {
            return parser;
        }
    }

    function load(url) {

        const requestStartDate = new Date();
        const request = new TextRequest(url, HTTPRequest.GET);

        if (!request.startDate) {
            request.startDate = requestStartDate;
        }

        eventBus.trigger(
            Events.MANIFEST_LOADING_STARTED, {
                request
            }
        );

        urlLoader.load({
            request: request,
            success: function (bytes, textStatus) {
                // Manage situations in which success is called after calling reset
                if (!xlinkController) {
                    return;
                }

                // A response of no content implies in-memory is properly up to date
                if (textStatus == 'No Content') {
                    eventBus.trigger(
                        Events.INTERNAL_MANIFEST_LOADED, {
                            manifest: null
                        }
                    );
                    return;
                }

                // Parse and validate the received extended manifest, extract the MPD
                let extended;
                try {
                    extended = JSON.parse(bytes);
                } catch (e) {
                    eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, {
                        manifest: null,
                        error: new DashJSError(
                            Errors.MANIFEST_LOADER_PARSING_FAILURE_ERROR_CODE,
                            Errors.MANIFEST_LOADER_PARSING_FAILURE_ERROR_MESSAGE + `${url}`
                        )
                    });
                    return;
                }
                if (!defenseController.addExtendedManifest(extended)) {
                    logger.debug('Failed to download extended manifest, rejected');
                    return;
                }
                
                let manifest;
                let contents = extended['start']['mpd'];
                let baseUri = extended['start']['base_uri'];

                // Create parser according to manifest type
                if (parser === null) {
                    parser = createParser(contents);
                }

                if (parser === null) {
                    eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, {
                        manifest: null,
                        error: new DashJSError(
                            Errors.MANIFEST_LOADER_PARSING_FAILURE_ERROR_CODE,
                            Errors.MANIFEST_LOADER_PARSING_FAILURE_ERROR_MESSAGE + `${url}`
                        )
                    });
                    return;
                }

                // init xlinkcontroller with created parser
                xlinkController.setParser(parser);

                try {
                    manifest = parser.parse(contents);
                } catch (e) {
                    eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, {
                        manifest: null,
                        error: new DashJSError(
                            Errors.MANIFEST_LOADER_PARSING_FAILURE_ERROR_CODE,
                            Errors.MANIFEST_LOADER_PARSING_FAILURE_ERROR_MESSAGE + `${url}`
                        )
                    });
                    return;
                }

                if (manifest) {
                    // URL from which the MPD was originally retrieved (MPD updates will not change this value)
                    if (!manifest.url) {
                        // manifest.url is used for MPD update polling. dash.js only schedules
                        // a refresh when manifest.type === 'dynamic' (live streams); the MPD
                        // embedded in an extended manifest is always static, so this URL is
                        // never re-fetched after initial load.
                        const newUrl = `${baseUri}static.mpd`;
                        logger.debug('Setting manifest URL to ' + newUrl);
                        manifest.url = newUrl;
                    } else {
                        logger.debug('Manifest URL is ' + manifest.url);
                    }
                    if (!manifest.originalUrl) {
                        manifest.originalUrl = manifest.url;
                    }

                    // If there is a mismatch between the manifest's specified duration and the total duration of all periods,
                    // and the specified duration is greater than the total duration of all periods,
                    // overwrite the manifest's duration attribute. This is a patch for if a manifest is generated incorrectly.
                    if (settings &&
                        settings.get().streaming.enableManifestDurationMismatchFix &&
                        manifest.mediaPresentationDuration &&
                        manifest.Period.length > 1) {
                        const sumPeriodDurations = manifest.Period.reduce((totalDuration, period) => totalDuration + period.duration, 0);
                        if (!isNaN(sumPeriodDurations) && manifest.mediaPresentationDuration > sumPeriodDurations) {
                            logger.warn('Media presentation duration greater than duration of all periods. Setting duration to total period duration');
                            manifest.mediaPresentationDuration = sumPeriodDurations;
                        }
                    }

                    manifest.baseUri = urlUtils.parseBaseUrl(baseUri);
                    logger.debug('Manifest base URI set to ' + manifest.baseUri);
                    manifest.loadedTime = new Date();
                    xlinkController.resolveManifestOnLoad(manifest);

                    eventBus.trigger(Events.ORIGINAL_MANIFEST_LOADED, { originalManifest: contents });
                } else {
                    eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, {
                        manifest: null,
                        error: new DashJSError(
                            Errors.MANIFEST_LOADER_PARSING_FAILURE_ERROR_CODE,
                            Errors.MANIFEST_LOADER_PARSING_FAILURE_ERROR_MESSAGE + `${url}`
                        )
                    });
                }
            },
            error: function (request, statusText, errorText) {
                eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, {
                    manifest: null,
                    error: new DashJSError(
                        Errors.MANIFEST_LOADER_LOADING_FAILURE_ERROR_CODE,
                        Errors.MANIFEST_LOADER_LOADING_FAILURE_ERROR_MESSAGE + `${url}, ${errorText}`
                    )
                });
                logger.debug('Failed to download extended manifest, ' + errorText);
            }
        });
    }

    function reset() {
        eventBus.off(Events.XLINK_READY, onXlinkReady, instance);

        if (mssHandler) {
            mssHandler.reset();
        }

        if (xlinkController) {
            xlinkController.reset();
            xlinkController = null;
        }

        if (urlLoader) {
            urlLoader.abort();
            urlLoader = null;
        }
    }

    instance = {
        load: load,
        reset: reset
    };

    setup();

    return instance;
}

ManifestLoader.__dashjs_factory_name = 'ManifestLoader';

const factory = FactoryMaker.getClassFactory(ManifestLoader);
export default factory;
