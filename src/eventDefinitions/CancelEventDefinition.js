import {brokerSafeId} from '../shared';
import {cloneContent, shiftParent} from '../messageHelper';

const cancelQSymbol = Symbol.for('cancelQ');
const completedSymbol = Symbol.for('completed');
const executeMessageSymbol = Symbol.for('executeMessage');

export default function CancelEventDefinition(activity, eventDefinition) {
  const {id, broker, environment, isThrowing} = activity;
  this.id = id;
  const type = this.type = eventDefinition.type;
  this.reference = {referenceType: 'cancel'};
  this.isThrowing = isThrowing;
  this.activity = activity;
  this.environment = activity.environment;
  this.broker = broker;
  this.logger = environment.Logger(type.toLowerCase());
  this[completedSymbol] = false;
  if (!isThrowing) {
    const cancelQueueName = `cancel-${brokerSafeId(id)}-q`;
    this[cancelQSymbol] = broker.assertQueue(cancelQueueName, {autoDelete: false, durable: true});
    broker.bindQueue(cancelQueueName, 'api', '*.cancel.#', {durable: true, priority: 400});
  }
}

const proto = CancelEventDefinition.prototype;

Object.defineProperty(proto, 'executionId', {
  get() {
    const message = this[executeMessageSymbol];
    return message && message.content.executionId;
  },
});

proto.execute = function execute(executeMessage) {
  this[executeMessageSymbol] = executeMessage;
  this[completedSymbol] = false;
  return this.isThrowing ? this.executeThrow(executeMessage) : this.executeCatch(executeMessage);
};

proto.executeCatch = function executeCatch(executeMessage) {
  const executeContent = executeMessage.content;
  const {executionId, parent} = executeContent;
  const parentExecutionId = parent.executionId;

  const broker = this.broker;
  const onCatchMessage = this._onCatchMessage.bind(this);
  this[cancelQSymbol].consume(onCatchMessage, {
    noAck: true,
    consumerTag: `_oncancel-${executionId}`,
  });

  if (this[completedSymbol]) return;

  const onApiMessage = this._onApiMessage.bind(this);
  broker.subscribeTmp('api', `activity.#.${parentExecutionId}`, onApiMessage, {
    noAck: true,
    consumerTag: `_api-parent-${parentExecutionId}`,
  });
  broker.subscribeTmp('api', `activity.#.${executionId}`, onApiMessage, {
    noAck: true,
    consumerTag: `_api-${executionId}`,
  });

  this._debug('expect cancel');

  const exchangeKey = `execute.canceled.${executionId}`;
  broker.subscribeOnce('execution', exchangeKey, onCatchMessage, {
    consumerTag: `_onattached-cancel-${executionId}`,
  });

  broker.publish('execution', 'execute.expect', cloneContent(executeContent, {
    pattern: '#.cancel',
    exchange: 'execution',
    exchangeKey,
  }));
};

proto.executeThrow = function executeThrow(executeMessage) {
  const {isTransaction} = this.environment.variables.content || {};
  const executeContent = executeMessage.content;
  const parent = executeContent.parent;

  this._debug(`throw cancel${isTransaction ? ' transaction' : ''}`);

  const broker = this.broker;
  const cancelContent = cloneContent(executeContent, {
    isTransaction,
    executionId: parent.executionId,
    state: 'throw',
  });
  cancelContent.parent = shiftParent(parent);

  broker.publish('event', 'activity.cancel', cancelContent, {type: 'cancel', delegate: isTransaction});

  return broker.publish('execution', 'execute.completed', cloneContent(executeContent));
};

proto._onCatchMessage = function onCatchMessage(_, message) {
  if (message.content && message.content.isTransaction) return this._onCancelTransaction(_, message);

  this._debug(`cancel caught from <${message.content.id}>`);
  return this._complete(message.content.message);
};

proto._onCancelTransaction = function onCancelTransaction(_, message) {
  const broker = this.broker, executionId = this.executionId;
  const executeContent = this[executeMessageSymbol].content;
  broker.cancel(`_oncancel-${executionId}`);

  this._debug(`cancel transaction thrown by <${message.content.id}>`);

  broker.assertExchange('cancel', 'topic');
  broker.publish('execution', 'execute.detach', cloneContent(executeContent, {
    pattern: '#',
    bindExchange: 'cancel',
    sourceExchange: 'event',
    sourcePattern: '#',
  }));

  broker.publish('event', 'activity.compensate', cloneContent(message.content, {
    state: 'throw',
  }), {type: 'compensate', delegate: true});

  broker.subscribeTmp('cancel', 'activity.leave', (__, {content: msg}) => {
    if (msg.id !== executeContent.attachedTo) return;
    return this._complete(message.content.message);
  }, {noAck: true, consumerTag: `_oncancelend-${executionId}`});
};

proto._complete = function complete(output) {
  this[completedSymbol] = true;
  this._stop();
  this._debug('completed');
  const content = cloneContent(this[executeMessageSymbol].content, {
    output,
    state: 'cancel',
  });
  return this.broker.publish('execution', 'execute.completed', content);
};

proto._onApiMessage = function onApiMessage(routingKey, message) {
  switch (message.properties.type) {
    case 'discard': {
      this[completedSymbol] = true;
      this._stop();
      const content = cloneContent(this[executeMessageSymbol].content);
      return this.broker.publish('execution', 'execute.discard', content);
    }
    case 'stop': {
      this._stop();
      break;
    }
  }
};

proto._stop = function stop() {
  const broker = this.broker;
  const {executionId, parent} = this[executeMessageSymbol].content;
  broker.cancel(`_api-parent-${parent.executionId}`);
  broker.cancel(`_api-${executionId}`);
  broker.cancel(`_oncancel-${executionId}`);
  broker.cancel(`_oncancelend-${executionId}`);
  broker.cancel(`_onattached-cancel-${executionId}`);
  this[cancelQSymbol].purge();
};

proto._debug = function debug(msg) {
  this.logger.debug(`<${this.executionId} (${this.activity.id})> ${msg}`);
};
