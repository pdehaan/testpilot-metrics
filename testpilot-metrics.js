// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * Class that represents a metrics event broker. Events are sent to Google
 * Analytics if the `tid` parameter is set. Events are sent to Mozilla's
 * data pipeline via the Test Pilot add-on. No metrics code changes are
 * needed when the experiment is added to or removed from Test Pilot.
 * @constructor
 * @param {string} $0.id - addon ID, e.g. '@testpilot-addon'. See https://mdn.io/add_on_id.
 * @param {string} $0.version - addon version, e.g. '1.0.2'.
 * @param {string} $0.uid - unique identifier for a specific instance of an addon.
 * Used as Google Analytics user ID.
 * @param {string} [$0.tid] - Google Analytics tracking ID. Optional, but required
 * to send events to Google Analytics.
 * @param {string} [$0.type=webextension] - addon type. one of: 'webextension',
 * 'sdk', 'bootstrapped'.
 * @param {boolean} [$0.debug=false] - if true, enables logging. Note that this
 * value can be changed on a running instance, by modifying its `debug` property.
 * @throws {SyntaxError} If the required properties are missing, or if the
 * 'type' property is unrecognized.
 * @throws {Error} if initializing the transports fails.
 */
function Metrics({id, version, uid, tid = null, type = 'webextension', debug = false}) {
  if (!id) {
    throw new SyntaxError(`'id' property is required.`);
  } else if (!version) {
    throw new SyntaxError(`'version' property is required.`);
  } else if (!uid) {
    throw new SyntaxError(`'uid' property is required.`);
  }

  if (!['webextension', 'sdk', 'bootstrapped'].includes(type)) {
    throw new SyntaxError(`'type' property must be one of: 'webextension', 'sdk', or 'bootstrapped'`);
  }
  Object.assign(this, {id, uid, version, tid, type, debug});

  // The test pilot add-on uses its own nsIObserverService topic for sending
  // pings to Telemetry. Otherwise, the topic is based on add-on type.
  if (id === '@testpilot-addon') {
    this.topic = 'testpilot';
  } else if (type === 'webextension') {
    this.topic = 'testpilot-telemetry';
  } else {
    this.topic = 'testpilottest';
  }

  // NOTE: order is important here. _initTransports uses console.log, which may
  // not be available before _initConsole has run.
  this._initConsole();
  this._initTransports();

  this.sendEvent = this.sendEvent.bind(this);

  this._log(`Initialized topic to ${this.topic}`);
  if (!tid) {
    this._log(`Google Analytics disabled: 'tid' value not passed to constructor.`);
  } else {
    this._log(`Google Analytics enabled for Tracking ID ${tid}.`);
  }
  this._log(`Constructor finished successfully.`);
}
Metrics.prototype = {
  /**
   * Sends an event to the Mozilla data pipeline (and Google Analytics, if
   * a `tid` was passed to the constructor). Note: to avoid breaking callers,
   * if sending the event fails, no Errors will be thrown. Instead, the message
   * will be silently dropped, and, if debug mode is enabled, an error will be
   * logged to the Browser Console.
   *
   * If you want to pass extra fields to GA, or use a GA hit type other than
   * `Event`, you can transform the output data object yourself using the
   * `transform` parameter. You will need to add Custom Dimensions to GA for any
   * extra fields: https://support.google.com/analytics/answer/2709828. Note
   * that, by convention, the `variant` argument is mapped to the first Custom
   * Dimension (`cd1`) when constructing the GA Event hit.
   *
   * Note: the data object format is currently different for each experiment,
   * and should be defined based on the result of conversations with the Mozilla
   * data team.
   *
   * A suggested default format is:
   * @param {string} [$0.method] - What is happening? e.g. `click`
   * @param {string} [$0.object] - What is being affected? e.g. `home-button-1`
   * @param {string} [$0.category=interactions] - If you want to add a category
   * for easy reporting later. e.g. `mainmenu`
   * @param {string} [$0.variant] - An identifying string if you're running
   * different variants. e.g. `cohort-A`
   * @param {function} [transform] - Transform function used to alter the
   * parameters sent to GA. The `transform` function signature is
   * `transform(input, output)`, where `input` is the object passed to
   * `sendEvent` (excluding `transform`), and `output` is the default GA
   * object generated by the `_gaTransform` method. The `transform` function
   * should return an object whose keys are GA Measurement Protocol parameters.
   * The returned object will be form encoded and sent to GA.
   */
  sendEvent: function({method, object=null, category='interactions', variant=null} = {}, transform) {
    this._log(`sendEvent called with method = ${method}, object = ${object}, category = ${category}, variant = ${variant}.`);

    const clientData = this._clone(arguments[0]);
    const gaData = this._clone(arguments[0]);
    if (!clientData) {
      this._error(`Unable to process data object. Dropping packet.`);
      return;
    }
    this._sendToClient(clientData);

    if (this.tid) {
      const defaultEvent = this._gaTransform(gaData);

      let userEvent;
      if (transform) {
        userEvent = transform.call(null, gaData, defaultEvent);
      }

      this._gaSend(userEvent || defaultEvent);
    }
  },

  /**
   * Clone a data object by serializing / deserializing it.
   * @private
   * @param {object} o - Object to be cloned.
   * @returns A clone of the object, or `null` if cloning failed.
   */
  _clone: function(o) {
    let cloned;
    try {
      cloned = JSON.parse(JSON.stringify(o));
    } catch (ex) {
      this._error(`Unable to clone object: ${ex}.`);
      return null;
    }
    return cloned;
  },

  /**
   * Sends an event to the Mozilla data pipeline via the Test Pilot add-on.
   * Uses BroadcastChannel for WebExtensions, and nsIObserverService for other
   * add-on types.
   * @private
   * @param {object} params - Entire object sent to `sendEvent`.
   */
  _sendToClient: function(params) {
    if (this.type === 'webextension') {
      this._channel.postMessage(params);
      this._log(`Sent client message via postMessage: ${params}`);
    } else {
      let stringified;

      try {
        stringified = JSON.stringify(params);
      } catch(ex) {
        this._error(`Unable to serialize metrics event: ${ex}`);
        return;
      }

      const subject = {
        wrappedJSObject: {
          observersModuleSubjectWrapper: true,
          object: this.id
        }
      };

      try {
        Services.obs.notifyObservers(subject, 'testpilot::send-metric', stringified);
        this._log(`Sent client message via nsIObserverService: ${stringified}`);
      } catch (ex) {
        this._error(`Failed to send nsIObserver client ping: ${ex}`);
        return;
      }
    }
  },

   /**
   * Transforms `sendEvent()` arguments into a Google Analytics `Event` hit.
   * @private
   * @param {string} method - see `sendEvent` docs
   * @param {string} [object] - see `sendEvent` docs
   * @param {string} category - see `sendEvent` docs. Note that `category` is
   * required here, assuming the default value was filled in by `sendEvent()`.
   * @param {string} variant - see `sendEvent` docs. Note that `variant` is
   * required here, assuming the default value was filled in by `sendEvent()`.
   */
  _gaTransform: function(method, object, category, variant) {
    const data = {
      v: 1,
      an: this.id,
      av: this.version,
      tid: this.tid,
      uid: this.uid,
      t: 'event',
      ec: category,
      ea: method
    };
    if (object) {
      data.el = object;
    }
    if (variant) {
      data.cd1 = variant;
    }
    return data;
  },

  /**
   * Encodes and sends an event message to Google Analytics.
   * @private
   * @param {object} msg - An object whose keys correspond to parameters in the
   * Google Analytics Measurement Protocol.
   */
  _gaSend: function(msg) {
    const encoded = this._formEncode(msg);
    const GA_URL = 'https://ssl.google-analytics.com/collect';
    if (this.type === 'webextension') {
      navigator.sendBeacon(GA_URL, encoded);
    } else {
      // SDK and bootstrapped types might not have a window reference, so get
      // the sendBeacon DOM API from the hidden window.
      Services.appShell.hiddenDOMWindow.navigator.sendBeacon(GA_URL, encoded);
    }
    this._log(`Sent GA message: ${encoded}`);
  },

  /**
   * URL encodes an object. Encodes spaces as '%20', not '+', following the
   * GA docs.
   *
   * @example
   * // returns 'a=b&foo=b%20ar'
   * metrics._formEncode({a: 'b', foo: 'b ar'});
   * @private
   * @param {Object} obj - Any JS object
   * @returns {string}
   */
  _formEncode: function(obj) {
    const params = [];
    if (!obj) { return ''; }
    Object.keys(obj).forEach(item => {
      let encoded = encodeURIComponent(item) + '=' + encodeURIComponent(obj[item]);
      params.push(encoded);
    });
    return params.join('&');
  },

  /**
   * Initializes transports used for sending messages. For WebExtensions,
   * creates a `BroadcastChannel` (transport for client pings). WebExtensions
   * use navigator.sendBeacon for GA transport, and they always have access
   * to DOM APIs, so there's no setup work required. For other types, loads
   * `Services.jsm`, which exposes the nsIObserverService (transport for client
   * pings), and exposes the navigator.sendBeacon API (GA transport) via the
   * appShell service's hidden window.
   * @private
   * @throws {Error} if transport setup unexpectedly fails
   */
  _initTransports: function() {
    if (this.type === 'webextension') {
      try {
        this._channel = new BroadcastChannel(this.topic);
      } catch(ex) {
        throw new Error(`Unable to create BroadcastChannel: ${ex}`);
      }
    } else if (this.type === 'sdk') {
      try {
        const { Cu } = require('chrome');
        Cu.import('resource://gre/modules/Services.jsm');
      } catch(ex) {
        throw new Error(`Unable to load Services.jsm: ${ex}`);
      }
    } else { /* this.type === 'bootstrapped' */
      try {
        Components.utils.import('resource://gre/modules/Services.jsm');
      } catch(ex) {
        throw new Error(`Unable to load Services.jsm: ${ex}`);
      }
    }
    this._log('Successfully initialized transports.');
  },

  /**
   * Initializes a console for 'bootstrapped' add-ons.
   * @private
   */
  _initConsole: function() {
    if (this.type === 'bootstrapped') {
      try {
        Components.utils.import('resource://gre/modules/Console.jsm');
        this._log('Successfully initialized console.');
      } catch(ex) {
        throw new Error(`Unable to initialize console: ${ex}`);
      }
    }
  },

  /**
   * Logs messages to the console. Only enabled if `this.debug` is truthy.
   * @private
   * @param {string} msg - A message
   */
  _log: function(msg) {
    if (this.debug) {
      console.log(msg);
    }
  },

  /**
   * Logs errors to the console. Only enabled if `this.debug` is truthy.
   * @private
   * @param {string} msg - An error message
   */
  _error: function(msg) {
    if (this.debug) {
      console.error(msg);
    }
  }
};

// WebExtensions don't support CommonJS module style, so 'module' might not be
// defined.
if (typeof module !== 'undefined') {
  module.exports = Metrics;
}

// Export the Metrics constructor in Gecko JSM style, for legacy addons
// that use the JSM loader. See also: https://mdn.io/jsm/using
const EXPORTED_SYMBOLS = ['Metrics'];
