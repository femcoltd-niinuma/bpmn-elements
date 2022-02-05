"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _Api = require("../Api");

var _messageHelper = require("../messageHelper");

var _shared = require("../shared");

var _default = ProcessExecution;
exports.default = _default;
const activatedSymbol = Symbol.for('activated');
const activityQSymbol = Symbol.for('activityQ');
const completedSymbol = Symbol.for('completed');
const elementsSymbol = Symbol.for('elements');
const executeMessageSymbol = Symbol.for('executeMessage');
const messageHandlersSymbol = Symbol.for('messageHandlers');
const parentSymbol = Symbol.for('parent');
const statusSymbol = Symbol.for('status');
const stoppedSymbol = Symbol.for('stopped');

function ProcessExecution(parentActivity, context) {
  const {
    id,
    type,
    broker,
    isSubProcess
  } = parentActivity;
  this[parentSymbol] = parentActivity;
  this.id = id;
  this.type = type;
  this.isSubProcess = isSubProcess;
  this.broker = broker;
  this.environment = context.environment;
  this.context = context;
  this[elementsSymbol] = {
    children: context.getActivities(id),
    associations: context.getAssociations(id),
    flows: context.getSequenceFlows(id),
    outboundMessageFlows: context.getMessageFlows(id),
    startActivities: [],
    triggeredByEvent: [],
    detachedActivities: [],
    startSequences: {},
    postponed: []
  };
  const exchangeName = this._exchangeName = isSubProcess ? 'subprocess-execution' : 'execution';
  broker.assertExchange(exchangeName, 'topic', {
    autoDelete: false,
    durable: true
  });
  this[completedSymbol] = false;
  this[stoppedSymbol] = false;
  this[activatedSymbol] = false;
  this[statusSymbol] = 'init';
  this.executionId = undefined;
  this[messageHandlersSymbol] = {
    onActivityEvent: this._onActivityEvent.bind(this),
    onApiMessage: this._onApiMessage.bind(this),
    onChildMessage: this._onChildMessage.bind(this),
    onMessageFlowEvent: this._onMessageFlowEvent.bind(this)
  };
}

const proto = ProcessExecution.prototype;
Object.defineProperty(proto, 'stopped', {
  enumerable: true,

  get() {
    return this[stoppedSymbol];
  }

});
Object.defineProperty(proto, 'completed', {
  enumerable: true,

  get() {
    return this[completedSymbol];
  }

});
Object.defineProperty(proto, 'status', {
  enumerable: true,

  get() {
    return this[statusSymbol];
  }

});
Object.defineProperty(proto, 'postponedCount', {
  get() {
    return this[elementsSymbol].postponed.length;
  }

});
Object.defineProperty(proto, 'isRunning', {
  get() {
    return this[activatedSymbol];
  }

});

proto.execute = function execute(executeMessage) {
  if (!executeMessage) throw new Error('Process execution requires message');
  if (!executeMessage.content || !executeMessage.content.executionId) throw new Error('Process execution requires execution id');
  const executionId = this.executionId = executeMessage.content.executionId;
  this[executeMessageSymbol] = (0, _messageHelper.cloneMessage)(executeMessage, {
    executionId,
    state: 'start'
  });
  this[stoppedSymbol] = false;
  this.environment.assignVariables(executeMessage);
  this[activityQSymbol] = this.broker.assertQueue(`execute-${executionId}-q`, {
    durable: true,
    autoDelete: false
  });

  if (executeMessage.fields.redelivered) {
    return this.resume();
  }

  this._debug(`execute ${this.isSubProcess ? 'sub process' : 'process'}`);

  this._activate();

  this._start();

  return true;
};

proto.resume = function resume() {
  this._debug(`resume process execution at ${this.status}`);

  if (this[completedSymbol]) return this._complete('completed');

  this._activate();

  const {
    startActivities,
    detachedActivities,
    postponed
  } = this[elementsSymbol];

  if (startActivities.length > 1) {
    for (const a of startActivities) a.shake();
  }

  postponed.splice(0);
  detachedActivities.splice(0);
  this[activityQSymbol].consume(this[messageHandlersSymbol].onChildMessage, {
    prefetch: 1000,
    consumerTag: `_process-activity-${this.executionId}`
  });
  if (this[completedSymbol]) return this._complete('completed');

  switch (this.status) {
    case 'init':
      return this._start();

    case 'executing':
      {
        if (!postponed.length) return this._complete('completed');
        break;
      }
  }

  for (const {
    content
  } of postponed.slice()) {
    const activity = this.getActivityById(content.id);
    if (!activity) continue;
    if (content.placeholder) continue;
    activity.resume();
  }
};

proto.recover = function recover(state) {
  if (!state) return this;
  this.executionId = state.executionId;
  this[stoppedSymbol] = state.stopped;
  this[completedSymbol] = state.completed;
  this[statusSymbol] = state.status;

  this._debug(`recover process execution at ${this.status}`);

  if (state.messageFlows) {
    for (const flowState of state.messageFlows) {
      const flow = this._getMessageFlowById(flowState.id);

      if (!flow) continue;
      flow.recover(flowState);
    }
  }

  if (state.associations) {
    for (const associationState of state.associations) {
      const association = this._getAssociationById(associationState.id);

      if (!association) continue;
      association.recover(associationState);
    }
  }

  if (state.flows) {
    for (const flowState of state.flows) {
      const flow = this._getFlowById(flowState.id);

      if (!flow) continue;
      flow.recover(flowState);
    }
  }

  if (state.children) {
    for (const childState of state.children) {
      const child = this.getActivityById(childState.id);
      if (!child) continue;
      child.recover(childState);
    }
  }

  return this;
};

proto.shake = function shake(fromId) {
  let executing = true;
  const id = this.id;

  if (!this.isRunning) {
    executing = false;
    this.executionId = (0, _shared.getUniqueId)(id);

    this._activate();
  }

  const toShake = fromId ? [this.getActivityById(fromId)].filter(Boolean) : this[elementsSymbol].startActivities;
  const result = {};
  this.broker.subscribeTmp('event', '*.shake.*', (routingKey, {
    content
  }) => {
    let isLooped = false;

    switch (routingKey) {
      case 'flow.shake.loop':
        isLooped = true;

      case 'activity.shake.end':
        {
          const {
            id: shakeId,
            parent: shakeParent
          } = content;
          if (shakeParent.id !== id) return;
          result[shakeId] = result[shakeId] || [];
          result[shakeId].push({ ...content,
            isLooped
          });
          break;
        }
    }
  }, {
    noAck: true,
    consumerTag: `_shaker-${this.executionId}`
  });

  for (const a of toShake) a.shake();

  if (!executing) this._deactivate();
  this.broker.cancel(`_shaker-${this.executionId}`);
  return result;
};

proto.stop = function stop() {
  this.getApi().stop();
};

proto.getPostponed = function getPostponed(filterFn) {
  return this[elementsSymbol].postponed.slice().reduce((result, msg) => {
    const api = this._getChildApi(msg);

    if (api) {
      if (filterFn && !filterFn(api)) return result;
      result.push(api);
    }

    return result;
  }, []);
};

proto.discard = function discard() {
  this[statusSymbol] = 'discard';
  return this[activityQSymbol].queueMessage({
    routingKey: 'execution.discard'
  }, {
    id: this.id,
    type: this.type,
    executionId: this.executionId
  }, {
    type: 'discard'
  });
};

proto.getState = function getState() {
  const {
    flows,
    outboundMessageFlows,
    associations
  } = this[elementsSymbol];
  return {
    executionId: this.executionId,
    stopped: this[stoppedSymbol],
    completed: this[completedSymbol],
    status: this.status,
    children: this[elementsSymbol].children.reduce((result, activity) => {
      if (activity.placeholder) return result;
      result.push(activity.getState());
      return result;
    }, []),
    flows: flows.map(f => f.getState()),
    messageFlows: outboundMessageFlows.map(f => f.getState()),
    associations: associations.map(f => f.getState())
  };
};

proto.getActivities = function getActivities() {
  return this[elementsSymbol].children.slice();
};

proto.getActivityById = function getActivityById(activityId) {
  return this[elementsSymbol].children.find(child => child.id === activityId);
};

proto.getSequenceFlows = function getSequenceFlows() {
  return this[elementsSymbol].flows.slice();
};

proto.getApi = function getApi(message) {
  if (!message) return (0, _Api.ProcessApi)(this.broker, this[executeMessageSymbol]);
  const content = message.content;

  if (content.executionId !== this.executionId) {
    return this._getChildApi(message);
  }

  const api = (0, _Api.ProcessApi)(this.broker, message);
  const postponed = this[elementsSymbol].postponed;
  const self = this;

  api.getExecuting = function getExecuting() {
    return postponed.reduce((result, msg) => {
      const childApi = self._getChildApi(msg);

      if (childApi) result.push(childApi);
      return result;
    }, []);
  };

  return api;
};

proto._start = function start() {
  if (this[elementsSymbol].children.length === 0) {
    return this._complete('completed');
  }

  this[statusSymbol] = 'start';
  const executeContent = { ...this[executeMessageSymbol].content,
    state: this.status
  };
  this.broker.publish(this._exchangeName, 'execute.start', (0, _messageHelper.cloneContent)(executeContent));
  const {
    startActivities,
    postponed,
    detachedActivities
  } = this[elementsSymbol];

  if (startActivities.length > 1) {
    for (const a of startActivities) a.shake();
  }

  for (const a of startActivities) a.init();

  for (const a of startActivities) a.run();

  postponed.splice(0);
  detachedActivities.splice(0);
  this[activityQSymbol].assertConsumer(this[messageHandlersSymbol].onChildMessage, {
    prefetch: 1000,
    consumerTag: `_process-activity-${this.executionId}`
  });
};

proto._activate = function activate() {
  const {
    onApiMessage,
    onMessageFlowEvent,
    onActivityEvent
  } = this[messageHandlersSymbol];
  this.broker.subscribeTmp('api', '#', onApiMessage, {
    noAck: true,
    consumerTag: `_process-api-consumer-${this.executionId}`,
    priority: 200
  });
  const {
    outboundMessageFlows,
    flows,
    associations,
    startActivities,
    triggeredByEvent,
    children
  } = this[elementsSymbol];

  for (const flow of outboundMessageFlows) {
    flow.activate();
    flow.broker.subscribeTmp('event', '#', onMessageFlowEvent, {
      consumerTag: '_process-message-consumer',
      noAck: true,
      priority: 200
    });
  }

  for (const flow of flows) {
    flow.broker.subscribeTmp('event', '#', onActivityEvent, {
      consumerTag: '_process-flow-controller',
      noAck: true,
      priority: 200
    });
  }

  for (const association of associations) {
    association.broker.subscribeTmp('event', '#', onActivityEvent, {
      consumerTag: '_process-association-controller',
      noAck: true,
      priority: 200
    });
  }

  startActivities.splice(0);
  triggeredByEvent.splice(0);

  for (const activity of children) {
    if (activity.placeholder) continue;
    activity.activate(this);
    activity.broker.subscribeTmp('event', '#', onActivityEvent, {
      noAck: true,
      consumerTag: '_process-activity-consumer',
      priority: 200
    });
    if (activity.isStart) startActivities.push(activity);
    if (activity.triggeredByEvent) triggeredByEvent.push(activity);
  }

  this[activatedSymbol] = true;
};

proto._deactivate = function deactivate() {
  const broker = this.broker;
  const executionId = this.executionId;
  broker.cancel(`_process-api-consumer-${executionId}`);
  broker.cancel(`_process-activity-${executionId}`);
  const {
    children,
    flows,
    associations,
    outboundMessageFlows
  } = this[elementsSymbol];

  for (const activity of children) {
    if (activity.placeholder) continue;
    activity.broker.cancel('_process-activity-consumer');
    activity.deactivate();
  }

  for (const flow of flows) {
    flow.broker.cancel('_process-flow-controller');
  }

  for (const association of associations) {
    association.broker.cancel('_process-association-controller');
  }

  for (const flow of outboundMessageFlows) {
    flow.deactivate();
    flow.broker.cancel('_process-message-consumer');
  }

  this[activatedSymbol] = false;
};

proto._onDelegateEvent = function onDelegateEvent(message) {
  const eventType = message.properties.type;
  let delegate = true;
  const content = message.content;

  if (content.message && content.message.id) {
    this._debug(`delegate ${eventType} event with id <${content.message.id}>`);
  } else {
    this._debug(`delegate ${eventType} anonymous event`);
  }

  for (const activity of this[elementsSymbol].triggeredByEvent) {
    if (activity.getStartActivities({
      referenceId: content.message && content.message.id,
      referenceType: eventType
    }).length) {
      delegate = false;
      activity.run(content.message);
    }
  }

  this.getApi().sendApiMessage(eventType, content, {
    delegate: true
  });
  return delegate;
};

proto._onMessageFlowEvent = function onMessageFlowEvent(routingKey, message) {
  this.broker.publish('message', routingKey, (0, _messageHelper.cloneContent)(message.content), message.properties);
};

proto._onActivityEvent = function onActivityEvent(routingKey, message) {
  if (message.fields.redelivered && message.properties.persistent === false) return;
  const content = message.content;
  const parent = content.parent = content.parent || {};
  let delegate = message.properties.delegate;
  const shaking = message.properties.type === 'shake';
  const isDirectChild = content.parent.id === this.id;

  if (isDirectChild) {
    parent.executionId = this.executionId;
  } else {
    content.parent = (0, _messageHelper.pushParent)(parent, {
      id: this.id,
      type: this.type,
      executionId: this.executionId
    });
  }

  if (delegate) delegate = this._onDelegateEvent(message);
  this.broker.publish('event', routingKey, content, { ...message.properties,
    delegate,
    mandatory: false
  });
  if (shaking) return this._onShookEnd(message);
  if (!isDirectChild) return;
  if (content.isAssociation) return;

  switch (routingKey) {
    case 'process.terminate':
      return this[activityQSymbol].queueMessage({
        routingKey: 'execution.terminate'
      }, (0, _messageHelper.cloneContent)(content), {
        type: 'terminate',
        persistent: true
      });

    case 'activity.stop':
      return;
  }

  this[activityQSymbol].queueMessage(message.fields, (0, _messageHelper.cloneContent)(content), {
    persistent: true,
    ...message.properties
  });
};

proto._onChildMessage = function onChildMessage(routingKey, message) {
  if (message.fields.redelivered && message.properties.persistent === false) return message.ack();
  const content = message.content;

  switch (routingKey) {
    case 'execution.stop':
      message.ack();
      return this._stopExecution(message);

    case 'execution.terminate':
      message.ack();
      return this._terminate(message);

    case 'execution.discard':
      message.ack();
      return this._onDiscard(message);

    case 'activity.compensation.end':
    case 'flow.looped':
    case 'activity.leave':
      return this._onChildCompleted(message);
  }

  this._stateChangeMessage(message, true);

  switch (routingKey) {
    case 'activity.detach':
      {
        this[elementsSymbol].detachedActivities.push((0, _messageHelper.cloneMessage)(message));
        break;
      }

    case 'activity.discard':
    case 'activity.compensation.start':
    case 'activity.enter':
      {
        this[statusSymbol] = 'executing';
        if (!content.inbound) break;

        for (const inbound of content.inbound) {
          if (!inbound.isSequenceFlow) continue;

          const inboundMessage = this._popPostponed(inbound);

          if (inboundMessage) inboundMessage.ack();
        }

        break;
      }

    case 'flow.error':
    case 'activity.error':
      {
        const eventCaughtBy = this[elementsSymbol].postponed.find(msg => {
          if (msg.fields.routingKey !== 'activity.catch') return;
          return msg.content.source && msg.content.source.executionId === content.executionId;
        });

        if (eventCaughtBy) {
          return this._debug('error was caught');
        }

        return this._complete('error', {
          error: content.error
        });
      }
  }
};

proto._stateChangeMessage = function stateChangeMessage(message, postponeMessage) {
  const previousMsg = this._popPostponed(message.content);

  if (previousMsg) previousMsg.ack();
  if (postponeMessage) this[elementsSymbol].postponed.push(message);
};

proto._popPostponed = function popPostponed(byContent) {
  const {
    postponed,
    detachedActivities
  } = this[elementsSymbol];
  const postponedIdx = postponed.findIndex(msg => {
    if (msg.content.isSequenceFlow) return msg.content.sequenceId === byContent.sequenceId;
    return msg.content.executionId === byContent.executionId;
  });
  let postponedMsg;

  if (postponedIdx > -1) {
    postponedMsg = postponed.splice(postponedIdx, 1)[0];
  }

  const detachedIdx = detachedActivities.findIndex(msg => msg.content.executionId === byContent.executionId);
  if (detachedIdx > -1) detachedActivities.splice(detachedIdx, 1);
  return postponedMsg;
};

proto._onChildCompleted = function onChildCompleted(message) {
  this._stateChangeMessage(message, false);

  if (message.fields.redelivered) return message.ack();
  const {
    id,
    type,
    isEnd
  } = message.content;
  const {
    postponed,
    detachedActivities,
    startActivities
  } = this[elementsSymbol];
  const postponedCount = postponed.length;

  if (!postponedCount) {
    this._debug(`left <${id}> (${type}), pending runs ${postponedCount}`);

    message.ack();
    return this._complete('completed');
  }

  this._debug(`left <${id}> (${type}), pending runs ${postponedCount}, ${postponed.map(a => a.content.id).join(',')}`);

  if (postponedCount === detachedActivities.length) {
    for (const api of this.getPostponed()) api.discard();

    return;
  }

  if (isEnd && startActivities.length) {
    const startSequences = this[elementsSymbol].startSequences;

    for (const msg of postponed) {
      const postponedId = msg.content.id;
      const startSequence = startSequences[postponedId];

      if (startSequence) {
        if (startSequence.content.sequence.some(({
          id: sid
        }) => sid === id)) {
          this._getChildApi(msg).discard();
        }
      }
    }
  }
};

proto._stopExecution = function stopExecution(message) {
  if (this[stoppedSymbol]) return;
  const postponedCount = this.postponedCount;

  this._debug(`stop process execution (stop child executions ${postponedCount})`);

  if (postponedCount) {
    for (const api of this.getPostponed()) api.stop();
  }

  this._deactivate();

  this[stoppedSymbol] = true;
  return this.broker.publish(this._exchangeName, `execution.stopped.${this.executionId}`, { ...this[executeMessageSymbol].content,
    ...(message && message.content)
  }, {
    type: 'stopped',
    persistent: false
  });
};

proto._onDiscard = function onDiscard() {
  this._deactivate();

  const running = this[elementsSymbol].postponed.splice(0);

  this._debug(`discard process execution (discard child executions ${running.length})`);

  for (const flow of this.getSequenceFlows()) flow.stop();

  for (const msg of running) this._getChildApi(msg).discard();

  this[activityQSymbol].purge();
  return this._complete('discard');
};

proto._onApiMessage = function onApiMessage(routingKey, message) {
  const executionId = this.executionId;
  const broker = this.broker;

  if (message.properties.delegate) {
    const {
      correlationId
    } = message.properties || (0, _shared.getUniqueId)(executionId);

    this._debug(`delegate api ${routingKey} message to children, with correlationId <${correlationId}>`);

    let consumed = false;
    broker.subscribeTmp('event', 'activity.consumed', (_, msg) => {
      if (msg.properties.correlationId === correlationId) {
        consumed = true;

        this._debug(`delegated api message was consumed by ${msg.content ? msg.content.executionId : 'unknown'}`);
      }
    }, {
      consumerTag: `_ct-delegate-${correlationId}`,
      noAck: true
    });

    for (const child of this[elementsSymbol].children) {
      if (child.placeholder) continue;
      child.broker.publish('api', routingKey, (0, _messageHelper.cloneContent)(message.content), message.properties);
      if (consumed) break;
    }

    return broker.cancel(`_ct-delegate-${correlationId}`);
  }

  if (this.id !== message.content.id) {
    const child = this.getActivityById(message.content.id);
    if (!child) return null;
    return child.broker.publish('api', routingKey, message.content, message.properties);
  }

  if (this.executionId !== message.content.executionId) return;

  switch (message.properties.type) {
    case 'discard':
      return this.discard(message);

    case 'stop':
      this[activityQSymbol].queueMessage({
        routingKey: 'execution.stop'
      }, (0, _messageHelper.cloneContent)(message.content), {
        persistent: false
      });
      break;
  }
};

proto._complete = function complete(completionType, content) {
  this._deactivate();

  this._debug(`process execution ${completionType}`);

  this[completedSymbol] = true;
  if (this.status !== 'terminated') this[statusSymbol] = completionType;
  const broker = this.broker;
  this[activityQSymbol].delete();
  return broker.publish(this._exchangeName, `execution.${completionType}.${this.executionId}`, (0, _messageHelper.cloneContent)(this[executeMessageSymbol].content, {
    output: { ...this.environment.output
    },
    ...content,
    state: completionType
  }), {
    type: completionType,
    mandatory: completionType === 'error'
  });
};

proto._terminate = function terminate(message) {
  this[statusSymbol] = 'terminated';

  this._debug('terminating process execution');

  const running = this[elementsSymbol].postponed.splice(0);

  for (const flow of this.getSequenceFlows()) flow.stop();

  for (const msg of running) {
    const {
      id: postponedId,
      isSequenceFlow
    } = msg.content;
    if (postponedId === message.content.id) continue;
    if (isSequenceFlow) continue;

    this._getChildApi(msg).stop();

    msg.ack();
  }

  this[activityQSymbol].purge();
};

proto._getFlowById = function getFlowById(flowId) {
  return this[elementsSymbol].flows.find(f => f.id === flowId);
};

proto._getAssociationById = function getAssociationById(associationId) {
  return this[elementsSymbol].associations.find(a => a.id === associationId);
};

proto._getMessageFlowById = function getMessageFlowById(flowId) {
  return this[elementsSymbol].outboundMessageFlows.find(f => f.id === flowId);
};

proto._getChildById = function getChildById(childId) {
  return this.getActivityById(childId) || this._getFlowById(childId);
};

proto._getChildApi = function getChildApi(message) {
  const content = message.content;

  let child = this._getChildById(content.id);

  if (child) return child.getApi(message);
  if (!content.parent) return;
  child = this._getChildById(content.parent.id);
  if (child) return child.getApi(message);
  if (!content.parent.path) return;

  for (const pp of content.parent.path) {
    child = this._getChildById(pp.id, message);
    if (child) return child.getApi(message);
  }
};

proto._onShookEnd = function onShookEnd(message) {
  const routingKey = message.fields.routingKey;
  if (routingKey !== 'activity.shake.end') return;
  this[elementsSymbol].startSequences[message.content.id] = (0, _messageHelper.cloneMessage)(message);
};

proto._debug = function debugMessage(logMessage) {
  this[parentSymbol].logger.debug(`<${this.executionId} (${this.id})> ${logMessage}`);
};