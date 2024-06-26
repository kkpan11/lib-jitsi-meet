
import { getLogger } from '@jitsi/logger';

import * as JitsiConferenceEvents from '../../JitsiConferenceEvents';
import { CodecMimeType } from '../../service/RTC/CodecMimeType';
import { MediaType } from '../../service/RTC/MediaType';
import browser from '../browser';

const logger = getLogger(__filename);

// Default video codec preferences on mobile and desktop endpoints.
const DESKTOP_VIDEO_CODEC_ORDER = [ CodecMimeType.VP9, CodecMimeType.VP8, CodecMimeType.H264, CodecMimeType.AV1 ];
const MOBILE_P2P_VIDEO_CODEC_ORDER = [ CodecMimeType.H264, CodecMimeType.VP8, CodecMimeType.VP9, CodecMimeType.AV1 ];
const MOBILE_VIDEO_CODEC_ORDER = [ CodecMimeType.VP8, CodecMimeType.VP9, CodecMimeType.H264, CodecMimeType.AV1 ];

/**
 * This class handles the codec selection mechanism for the conference based on the config.js settings.
 * The preferred codec is selected based on the settings and the list of codecs supported by the browser.
 * The preferred codec is published in presence which is then used by the other endpoints in the
 * conference to pick a supported codec at join time and when the call transitions between p2p and jvb
 * connections.
 */
export class CodecSelection {
    /**
     * Creates a new instance for a given conference.
     *
     * @param {JitsiConference} conference the conference instance
     * @param {*} options
     * @param {string} options.jvb settings (codec list, preferred and disabled) for the jvb connection.
     * @param {string} options.p2p settings (codec list, preferred and disabled) for the p2p connection.
     */
    constructor(conference, options) {
        this.codecPreferenceOrder = {};
        this.conference = conference;
        this.encodeTimeStats = new Map();
        this.options = options;
        this.screenshareCodec = {};
        this.visitorCodecs = [];

        for (const connectionType of Object.keys(options)) {
            // eslint-disable-next-line prefer-const
            let { disabledCodec, preferredCodec, preferenceOrder, screenshareCodec } = options[connectionType];
            const supportedCodecs = new Set(this._getSupportedVideoCodecs(connectionType));

            // Default preference codec order when no codec preferences are set in config.js
            let selectedOrder = Array.from(supportedCodecs);

            if (preferenceOrder) {
                preferenceOrder = preferenceOrder.map(codec => codec.toLowerCase());

                // Select all codecs that are supported by the browser.
                selectedOrder = preferenceOrder.filter(codec => supportedCodecs.has(codec));

            // Generate the codec list based on the supported codecs and the preferred/disabled (deprecated) settings
            } else if (preferredCodec || disabledCodec) {
                disabledCodec = disabledCodec?.toLowerCase();
                preferredCodec = preferredCodec?.toLowerCase();

                // VP8 cannot be disabled since it the default codec.
                if (disabledCodec && disabledCodec !== CodecMimeType.VP8) {
                    selectedOrder = selectedOrder.filter(codec => codec !== disabledCodec);
                }

                const index = selectedOrder.findIndex(codec => codec === preferredCodec);

                // Move the preferred codec to the top of the list.
                if (preferredCodec && index !== -1) {
                    selectedOrder.splice(index, 1);
                    selectedOrder.unshift(preferredCodec);
                }
            }

            // Push VP9 to the end of the list so that the client continues to decode VP9 even if its not
            // preferable to encode VP9 (because of browser bugs on the encoding side or added complexity on mobile
            // devices). Currently, VP9 encode is supported on Chrome and on Safari (only for p2p).
            const isVp9EncodeSupported = browser.supportsVP9() || (browser.isWebKitBased() && connectionType === 'p2p');

            if (!isVp9EncodeSupported || this.conference.isE2EEEnabled()) {
                const index = selectedOrder.findIndex(codec => codec === CodecMimeType.VP9);

                if (index !== -1) {
                    selectedOrder.splice(index, 1);

                    // Remove VP9 from the list when E2EE is enabled since it is not supported.
                    // TODO - remove this check when support for VP9-E2EE is introduced.
                    if (!this.conference.isE2EEEnabled()) {
                        selectedOrder.push(CodecMimeType.VP9);
                    }
                }
            }

            logger.info(`Codec preference order for ${connectionType} connection is ${selectedOrder}`);
            this.codecPreferenceOrder[connectionType] = selectedOrder;

            // Set the preferred screenshare codec.
            if (screenshareCodec && supportedCodecs.has(screenshareCodec)) {
                this.screenshareCodec[connectionType] = screenshareCodec;
            }
        }

        this.conference.on(
            JitsiConferenceEvents._MEDIA_SESSION_STARTED,
            session => this._selectPreferredCodec(session));
        this.conference.on(
            JitsiConferenceEvents.CONFERENCE_VISITOR_CODECS_CHANGED,
            codecList => this._updateVisitorCodecs(codecList));
        this.conference.on(
            JitsiConferenceEvents.USER_JOINED,
            () => this._selectPreferredCodec());
        this.conference.on(
            JitsiConferenceEvents.USER_LEFT,
            () => this._selectPreferredCodec());
        this.conference.on(
            JitsiConferenceEvents.ENCODE_TIME_STATS_RECEIVED,
            (tpc, stats) => this._processEncodeTimeStats(tpc, stats));
    }

    /**
     * Returns a list of video codecs that are supported by the browser.
     *
     * @param {string} connectionType - media connection type, p2p or jvb.
     * @returns {Array}
     */
    _getSupportedVideoCodecs(connectionType) {
        const videoCodecMimeTypes = browser.isMobileDevice() && connectionType === 'p2p'
            ? MOBILE_P2P_VIDEO_CODEC_ORDER
            : browser.isMobileDevice() ? MOBILE_VIDEO_CODEC_ORDER : DESKTOP_VIDEO_CODEC_ORDER;

        const supportedCodecs = videoCodecMimeTypes.filter(codec =>
            (window.RTCRtpReceiver?.getCapabilities?.(MediaType.VIDEO)?.codecs ?? [])
                .some(supportedCodec => supportedCodec.mimeType.toLowerCase() === `${MediaType.VIDEO}/${codec}`));

        // Select VP8 as the default codec if RTCRtpReceiver.getCapabilities() is not supported by the browser or if it
        // returns an empty set.
        !supportedCodecs.length && supportedCodecs.push(CodecMimeType.VP8);

        return supportedCodecs;
    }

    /**
     * Processes the encode time stats received for all the local video sources.
     *
     * @param {TraceablePeerConnection} tpc - the peerconnection for which stats were gathered.
     * @param {Object} stats - the encode time stats for local video sources.
     * @returns {void}
     */
    _processEncodeTimeStats(tpc, stats) {
        const activeSession = this.conference.getActiveMediaSession();

        // Process stats only for the active media session.
        if (activeSession.peerconnection !== tpc) {
            return;
        }

        const statsPerTrack = new Map();

        for (const ssrc of stats.keys()) {
            const { codec, encodeTime, qualityLimitationReason, resolution, timestamp } = stats.get(ssrc);
            const track = tpc.getTrackBySSRC(ssrc);
            let existingStats = statsPerTrack.get(track.rtcId);
            const encodeResolution = Math.min(resolution.height, resolution.width);
            const ssrcStats = {
                encodeResolution,
                encodeTime,
                qualityLimitationReason
            };

            if (existingStats) {
                existingStats.codec = codec;
                existingStats.timestamp = timestamp;
                existingStats.trackStats.push(ssrcStats);
            } else {
                existingStats = {
                    codec,
                    timestamp,
                    trackStats: [ ssrcStats ]
                };

                statsPerTrack.set(track.rtcId, existingStats);
            }
        }

        // Aggregate the stats for multiple simulcast streams with different SSRCs but for the same video stream.
        for (const trackId of statsPerTrack.keys()) {
            const { codec, timestamp, trackStats } = statsPerTrack.get(trackId);
            const totalEncodeTime = trackStats
                .map(stat => stat.encodeTime)
                .reduce((totalValue, currentValue) => totalValue + currentValue, 0);
            const avgEncodeTime = totalEncodeTime / trackStats.length;
            const { qualityLimitationReason = 'none' }
                = trackStats.find(stat => stat.qualityLimitationReason !== 'none') ?? {};
            const encodeResolution = trackStats
                .map(stat => stat.encodeResolution)
                .reduce((resolution, currentValue) => Math.max(resolution, currentValue), 0);
            const localTrack = this.conference.getLocalVideoTracks().find(t => t.rtcId === trackId);

            const exisitingStats = this.encodeTimeStats.get(trackId);
            const sourceStats = {
                avgEncodeTime,
                codec,
                encodeResolution,
                qualityLimitationReason,
                localTrack,
                timestamp
            };

            if (exisitingStats) {
                exisitingStats.push(sourceStats);
            } else {
                this.encodeTimeStats.set(trackId, [ sourceStats ]);
            }

            logger.debug(`Encode stats for ${localTrack}: codec=${codec}, time=${avgEncodeTime},`
                + `resolution=${encodeResolution}, qualityLimitationReason=${qualityLimitationReason}`);
        }
    }

    /**
     * Sets the codec on the media session based on the codec preference order configured in config.js and the supported
     * codecs published by the remote participants in their presence.
     *
     * @param {JingleSessionPC} mediaSession session for which the codec selection has to be made.
     */
    _selectPreferredCodec(mediaSession) {
        const session = mediaSession ? mediaSession : this.conference.jvbJingleSession;

        if (!session) {
            return;
        }
        const isJvbSession = session === this.conference.jvbJingleSession;
        let localPreferredCodecOrder = isJvbSession ? this.codecPreferenceOrder.jvb : this.codecPreferenceOrder.p2p;

        // E2EE is curently supported only for VP8 codec.
        if (this.conference.isE2EEEnabled() && isJvbSession) {
            localPreferredCodecOrder = [ CodecMimeType.VP8 ];
        }

        const remoteParticipants = this.conference.getParticipants().map(participant => participant.getId());
        const remoteCodecsPerParticipant = remoteParticipants?.map(remote => {
            const peerMediaInfo = session._signalingLayer.getPeerMediaInfo(remote, MediaType.VIDEO);

            if (peerMediaInfo?.codecList) {
                return peerMediaInfo.codecList;
            } else if (peerMediaInfo?.codecType) {
                return [ peerMediaInfo.codecType ];
            }

            return [];
        });

        // Include the visitor codecs.
        this.visitorCodecs.length && remoteCodecsPerParticipant.push(this.visitorCodecs);

        const selectedCodecOrder = localPreferredCodecOrder.reduce((acc, localCodec) => {
            let codecNotSupportedByRemote = false;

            // Ignore remote codecs for p2p since only the JVB codec preferences are published in presence.
            // For p2p, we rely on the codec order present in the remote offer/answer.
            if (!session.isP2P) {
                // Remove any codecs that are not supported by any of the remote endpoints. The order of the supported
                // codecs locally however will remain the same since we want to support asymmetric codecs.
                for (const remoteCodecs of remoteCodecsPerParticipant) {
                    // Ignore remote participants that do not publish codec preference in presence (transcriber).
                    if (remoteCodecs.length) {
                        codecNotSupportedByRemote = codecNotSupportedByRemote
                        || !remoteCodecs.find(participantCodec => participantCodec === localCodec);
                    }
                }
            }

            if (!codecNotSupportedByRemote) {
                acc.push(localCodec);
            }

            return acc;
        }, []);

        if (!selectedCodecOrder.length) {
            logger.warn('Invalid codec list generated because of a user joining/leaving the call');

            return;
        }

        session.setVideoCodecs(selectedCodecOrder);
    }

    /**
     * Updates the aggregate list of the codecs supported by all the visitors in the call and calculates the
     * selected codec if needed.
     * @param {Array} codecList - visitor codecs.
     * @returns {void}
     */
    _updateVisitorCodecs(codecList) {
        if (this.visitorCodecs === codecList) {
            return;
        }

        this.visitorCodecs = codecList;
        this._selectPreferredCodec();
    }

    /**
     * Returns the current codec preference order for the given connection type.
     *
     * @param {String} connectionType The media connection type, 'p2p' or 'jvb'.
     * @returns {Array<string>}
     */
    getCodecPreferenceList(connectionType) {
        return this.codecPreferenceOrder[connectionType];
    }

    /**
     * Returns the preferred screenshare codec for the given connection type.
     *
     * @param {String} connectionType The media connection type, 'p2p' or 'jvb'.
     * @returns CodecMimeType
     */
    getScreenshareCodec(connectionType) {
        return this.screenshareCodec[connectionType];
    }
}
