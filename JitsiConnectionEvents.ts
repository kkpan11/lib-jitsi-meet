/**
 * The events for the connection.
 */

export enum JitsiConnectionEvents {

    /**
     * Indicates that the connection has been disconnected. The event provides
     * the following parameters to its listeners:
     *
     * @param msg {string} a message associated with the disconnect such as the
     * last (known) error message
     */
    CONNECTION_DISCONNECTED = 'connection.connectionDisconnected',

    /**
     * Indicates that the connection has been established. The event provides
     * the following parameters to its listeners:
     *
     * @param id {string} the ID of the local endpoint/participant/peer (within
     * the context of the established connection)
     */
    CONNECTION_ESTABLISHED = 'connection.connectionEstablished',

    /**
     * Indicates that the connection has been failed for some reason. The event
     * provides the following parameters to its listeners:
     *
     * @param errType {JitsiConnectionErrors} the type of error associated with
     * the failure
     * @param errReason {string} the error (message) associated with the failure
     * @param credentials {object} the credentials used to connect (if any)
     * @param errReasonDetails {object} an optional object with details about
     * the error, like shard moving, suspending. Used for analytics purposes.
     */
    CONNECTION_FAILED = 'connection.connectionFailed',

    /**
     * The connection is redirected to a visitor node.
     */
    CONNECTION_REDIRECTED = 'connection.redirected',

    /**
     * Indicates that the display name is required over this connection and need to be supplied when
     * joining the room.
     * There are cases like lobby room where display name is required.
     */
    DISPLAY_NAME_REQUIRED = 'connection.display_name_required',

    /**
     * Indicates that the connection properties have been updated.
     * @param properties {object} - All available connection properties (e.g. shard, region).
     */
    PROPERTIES_UPDATED = 'connection.propertiesUpdated',
}

// exported for backward compatibility
export const CONNECTION_DISCONNECTED = JitsiConnectionEvents.CONNECTION_DISCONNECTED;
export const CONNECTION_ESTABLISHED = JitsiConnectionEvents.CONNECTION_ESTABLISHED;
export const CONNECTION_FAILED = JitsiConnectionEvents.CONNECTION_FAILED;
export const CONNECTION_REDIRECTED = JitsiConnectionEvents.CONNECTION_REDIRECTED;
export const DISPLAY_NAME_REQUIRED = JitsiConnectionEvents.DISPLAY_NAME_REQUIRED;
export const PROPERTIES_UPDATED = JitsiConnectionEvents.PROPERTIES_UPDATED;
