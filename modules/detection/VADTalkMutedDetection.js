import { EventEmitter } from 'events';
import { VAD_SCORE_PUBLISHED, VAD_TALK_WHILE_MUTED } from './DetectionEvents';
import { getLogger } from 'jitsi-meet-logger';
import TrackVADEmitter from '../detection/TrackVADEmitter';
import * as JitsiConferenceEvents from '../../JitsiConferenceEvents';

const logger = getLogger(__filename);

/**
 * The threshold which the average VAD values for a span of time needs to exceed to trigger an event.
 * @type {number}
 */
const VAD_AVG_THRESHOLD = 0.6;

/**
 * The VAD score needed to trigger the processing algorithm, i.e. if a sample has the VAD score >= VAD_VOICE_LEVEL
 * we start processing all scores for a time span defined by const PROCESS_TIME_FRAME_SPAN_MS.
 * @type {number}
 */
const VAD_VOICE_LEVEL = 0.9;

/**
 * Sample rate of TrackVADEmitter, it defines how many audio samples are processed at a time.
 * @type {number}
 */
const VAD_EMITTER_SAMPLE_RATE = 4096;

/**
 * Time span over which we calculate an average score used to determine if we trigger the event.
 * @type {number}
 */
const PROCESS_TIME_FRAME_SPAN_MS = 1500;

/**
 * Detect user trying to speak while is locally muted and fires an event using a TrackVADEmitter.
 */
export default class VADTalkMutedDetection extends EventEmitter {
    /**
     * Creates <tt>VADTalkMutedDetection</tt>
     * @param {JitsiConference} conference - JitsiConference instance that created us.
     * @param {Object} createVADProcessor - Function that creates a Voice activity detection processor. The processor
     * needs to implement the following functions:
     * - <tt>getSampleLength()</tt> - Returns the sample size accepted by getSampleLength.
     * - <tt>getRequiredPCMFrequency()</tt> - Returns the PCM frequency at which the processor operates.
     * - <tt>calculateAudioFrameVAD(pcmSample)</tt> - Process a 32 float pcm sample of getSampleLength size.
     * @constructor
     */
    constructor(conference, createVADProcessor) {
        super();

        /**
         * Member function that instantiates a VAD processor.
         */
        this._createVADProcessor = createVADProcessor;

        /**
         * Current {@link TrackVADEmitter}. VAD Emitter uses a {@link JitsiLocalTrack} and VAD processor to generate
         * period voice probability scores.
         */
        this._vadEmitter = null;

        /**
         * Flag which denotes the current state of the detection service i.e.if there is already a processing operation
         * ongoing.
         */
        this._processing = false;

        /**
         * Buffer that keeps the VAD scores for a period of time.
         */
        this._scoreArray = [];

        /**
         * Promise used to chain create and destroy operations associated with TRACK_ADDED and TRACK_REMOVED events
         * coming from the conference.
         * Because we have an async created component (VAD Processor) we need to make sure that it's initialized before
         * we destroy it ( when changing the device for instance), or when we use it from an external point of entry
         * i.e. (TRACK_MUTE_CHANGED event callback).
         */
        this._vadInitTracker = Promise.resolve();

        /**
         * {@link JitsiConference} bindings.
         */
        conference.on(JitsiConferenceEvents.TRACK_MUTE_CHANGED, this._trackMuteChanged.bind(this));
        conference.on(JitsiConferenceEvents.TRACK_ADDED, this._trackAdded.bind(this));
        conference.on(JitsiConferenceEvents.TRACK_REMOVED, this._trackRemoved.bind(this));

        // TODO do we need to handle the case where tracks are removed, make sure this cleans up properly so
        // we don't have any leeks i.e. stale JitsiLocalTracks
    }

    /**
     * Determine if the current score is high enough that we should start the final score processing, and make sure
     * there isn't already a process operation ongoing.
     *
     * @param {number} score - PCM sample VAD score.
     * @return {boolean}
     */
    _shouldStartVADCompute(vadScore) {
        return vadScore > VAD_VOICE_LEVEL && !this._processing;
    }

    /**
     * Determine if the computed score over the configured timestamp should trigger an event.
     *
     * @param {number} computedScore - Computed VAD score.
     * @returns {boolean} - Should or shouldn't trigger.
     */
    _shouldTriggerNotification(computedScore) {
        return computedScore > VAD_AVG_THRESHOLD;
    }

    /**
     * Start the {@link TrackVADEmitter} and attach the event listener.
     * @returns {void}
     */
    _startVADEmitter() {
        logger.info('Starting VAD Emitter for track', this._vadEmitter.getDeviceId());
        this._vadEmitter.on(VAD_SCORE_PUBLISHED, this._processVADScore.bind(this));
        this._vadEmitter.start();
    }

    /**
     * Stop the {@link TrackVADEmitter} and detach the event listener.
     * @returns {void}
     */
    _stopVADEmitter() {
        logger.info('Stopping VAD Emitter for track', this._vadEmitter.getDeviceId());
        this._vadEmitter.removeAllListeners(VAD_SCORE_PUBLISHED);
        this._vadEmitter.stop();
    }

    /**
     * Calculates the average value of a Float32Array.
     *
     * @param {Float32Array} scoreArray - Array of vad scores.
     * @returns {number} - Score average.
     */
    _calculateAverage(scoreArray) {
        let avg = 0;

        if (scoreArray.length) {
            const sum = scoreArray.reduce((a, b) => a + b);

            avg = sum / scoreArray.length;
        }

        return avg;
    }

    /**
     * Compute cumulative VAD score function called once the PROCESS_TIME_FRAME_SPAN_MS timeout has elapsed.
     * @returns {void}
     * @fires VAD_TALK_WHILE_MUTED
     */
    _calculateVADScore() {
        const score = this._calculateAverage(this._scoreArray);

        if (this._shouldTriggerNotification(score)) {
            /**
             * User is talking while the mic is muted, generate event.
             *
             * @event VAD_TALK_WHILE_MUTED.
             * @type {Object}
             */
            this.emit(VAD_TALK_WHILE_MUTED, {});

            logger.info('Triggered event for track: ', this._vadEmitter.getDeviceId());

            // Event was fired. Stop event emitter and remove listeners so no residue events kick off after this point
            // and a single VAD_TALK_WHILE_MUTED is generated per mic muted state.
            this._stopVADEmitter();
        }

        // We reset the context in case a new process phase needs to be triggered.
        this._reset();
    }

    /**
     * Listens for {@link TrackVADEmitter} events and processes them.
     *
     * @param {Object} vadScore -VAD score emitted by {@link TrackVADEmitter}
     * @param {Date}   vadScore.timestamp - Exact time at which processed PCM sample was generated.
     * @param {number} vadScore.score - VAD score on a scale from 0 to 1 (i.e. 0.7)
     * @param {string} vadScore.deviceId - Device id of the associated track.
     * @listens VAD_SCORE_PUBLISHED
     */
    _processVADScore(vadScore) {
        // Because we remove all listeners on the vadEmitter once the main event is triggered,
        // there is no need to check for rogue events.
        if (this._shouldStartVADCompute(vadScore.score)) {
            this._processing = true;

            // Start gathering VAD scores for the configured period of time.
            this._processTimeout = setTimeout(this._calculateVADScore.bind(this), PROCESS_TIME_FRAME_SPAN_MS);
        }

        // There is a processing phase on going, add score to buffer array.
        if (this._processing) {
            this._scoreArray.push(vadScore.score);
        }
    }

    /**
     * Determines whether a specific {@link JitsiTrack} represents a local audio track.
     *
     * @param {JitsiTrack} track - The track to be checked whether it represents a local audio track.
     * @return {boolean} - true if the specified track represents a local audio track; otherwise, false.
     */
    _isLocalAudioTrack(track) {
        return track.isAudioTrack() && track.isLocal();
    }

    /**
     * Reset the processing context, clear buffer, cancel the timeout trigger.
     *
     * @returns {void}
     */
    _reset() {
        this._processing = false;
        this._scoreArray = [];
        clearTimeout(this._processTimeout);
    }

    /**
     * Notifies the detector that a track was added to the associated {@link JitsiConference}.
     * Only take into account local audio tracks.
     * @param {JitsiTrack} track - The added track.
     * @returns {void}
     * @listens TRACK_ADDED
     */
    _trackAdded(track) {
        if (this._isLocalAudioTrack(track)) {
            // Keep a track promise so we take into account successive TRACK_ADD events being generated so that we
            // destroy/create the processing context in the proper order.
            this._vadInitTracker
                .then(() => this._createVADProcessor())
                .then(vadProcessor =>
                    TrackVADEmitter.create(track.getDeviceId(), VAD_EMITTER_SAMPLE_RATE, vadProcessor)
                )
                .then(vadEmitter => {
                    logger.info('Created VAD emitter for track: ', track.getDeviceId());

                    this._vadEmitter = vadEmitter;

                    if (track.isMuted()) {
                        this._startVADEmitter();
                    }
                });
        }
    }

    /**
     * Notifies the detector that the mute state of a {@link JitsiConference} track has changed. Only takes into account
     * local audio tracks. In case the track was muted the detector starts the {@link TrackVADEmitter} otherwise it's
     * stopped.
     * @param {JitsiTrack} track - The track whose mute state has changed.
     * @returns {void}
     * @listens TRACK_MUTE_CHANGED
     */
    _trackMuteChanged(track) {
        if (this._isLocalAudioTrack(track)) {
            // On a mute toggle reset the state.
            this._vadInitTracker.then(() => {
                logger.info('Changing track: ', track.getDeviceId(), ' muted status to:', track.isMuted());

                // Reset the processing context in between muted states so that each individual mute phase can generate
                // it's own event.
                this._reset();
                if (track.isMuted()) {
                    this._startVADEmitter();
                } else {
                    this._stopVADEmitter();
                }
            });
        }
    }

    /**
     * Notifies the detector that a track associated with the {@link JitsiConference} was removed. Only takes into
     * account local audio tracks. Cleans up resources associated with the track and resets the processing context.
     *
     * @param {JitsiTrack} track - The removed track.
     * @returns {void}
     * @listens TRACK_REMOVED
     */
    _trackRemoved(track) {
        if (this._isLocalAudioTrack(track)) {
            // Use the promise to make sure operations are in sequence.
            this._vadInitTracker.then(() => {
                logger.info('Removing track from VAD detection - ', track.getDeviceId());

                if (this._vadEmitter) {
                    this._stopVADEmitter();
                    this._reset();
                    this._vadEmitter.destroy();
                    this._vadEmitter = null;
                }
            });
        }
    }
}