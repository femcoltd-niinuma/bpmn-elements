"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = CompensationEventDefinition;

var _shared = require("../shared");

var _messageHelper = require("../messageHelper");

function CompensationEventDefinition(activity, eventDefinition, context) {
  const {
    id,
    broker,
    environment,
    isThrowing
  } = activity;
  const {
    type,
    behaviour = {}
  } = eventDefinition;
  const {
    debug
  } = environment.Logger(type.toLowerCase());
  const reference = behaviour.escalationRef || {
    name: 'anonymous'
  };
  const referenceElement = reference.id && context.getActivityById(reference.id);
  const compensationId = referenceElement ? referenceElement.id : 'anonymous';
  const compensationQueueName = `compensate-${(0, _shared.brokerSafeId)(id)}-${(0, _shared.brokerSafeId)(compensationId)}-q`;
  const associations = context.getOutboundAssociations(id) || [];
  if (!isThrowing) setupCatch();
  const source = {
    id,
    type,
    reference: { ...reference,
      referenceType: 'compensate'
    },
    execute: isThrowing ? executeThrow : executeCatch
  };
  return source;

  function executeCatch(executeMessage) {
    let completed;
    const messageContent = (0, _messageHelper.cloneContent)(executeMessage.content);
    const {
      executionId,
      parent
    } = messageContent;
    const parentExecutionId = parent && parent.executionId;
    const {
      message: referenceMessage,
      description
    } = resolveMessage(executeMessage);
    broker.consume(compensationQueueName, onCompensateApiMessage, {
      noAck: true,
      consumerTag: `_oncompensate-${executionId}`
    });
    if (completed) return;
    broker.subscribeTmp('api', `activity.#.${executionId}`, onApiMessage, {
      noAck: true,
      consumerTag: `_api-${executionId}`
    });
    if (completed) return stop();
    debug(`<${executionId} (${id})> expect ${description}`);
    broker.assertExchange('compensate', 'topic');
    const compensateQ = broker.assertQueue('compensate-q', {
      durable: true,
      autoDelete: false
    });
    broker.subscribeTmp('compensate', 'execute.#', onCollect, {
      noAck: true,
      consumerTag: '_oncollect-messages'
    });
    broker.publish('execution', 'execute.detach', (0, _messageHelper.cloneContent)({ ...messageContent,
      bindExchange: 'compensate'
    }));
    broker.publish('event', 'activity.detach', { ...messageContent,
      executionId: parentExecutionId,
      parent: (0, _messageHelper.shiftParent)(parent),
      bindExchange: 'compensate',
      expect: { ...referenceMessage
      }
    });

    function onCollect(routingKey, message) {
      switch (routingKey) {
        case 'execute.error':
        case 'execute.completed':
          {
            return compensateQ.queueMessage(message.fields, (0, _messageHelper.cloneContent)(message.content), message.properties);
          }
      }
    }

    function onCompensateApiMessage(routingKey, message) {
      const output = message.content.message;
      completed = true;
      stop();
      debug(`<${executionId} (${id})> caught ${description}`);
      broker.publish('event', 'activity.catch', { ...messageContent,
        message: { ...output
        },
        executionId: parentExecutionId,
        parent: (0, _messageHelper.shiftParent)(executeMessage.content.parent)
      }, {
        type: 'catch'
      });
      compensateQ.on('depleted', onDepleted);
      compensateQ.consume(onCollected, {
        noAck: true,
        consumerTag: '_convey-messages'
      });
      associations.forEach(association => {
        association.complete((0, _messageHelper.cloneMessage)(message));
      });

      function onDepleted() {
        compensateQ.off('depleted', onDepleted);
        return broker.publish('execution', 'execute.completed', { ...messageContent,
          output,
          state: 'catch'
        });
      }
    }

    function onCollected(routingKey, message) {
      associations.forEach(association => {
        association.take((0, _messageHelper.cloneMessage)(message));
      });
    }

    function onApiMessage(routingKey, message) {
      const messageType = message.properties.type;

      switch (messageType) {
        case 'compensate':
          {
            return onCompensateApiMessage(routingKey, message);
          }

        case 'discard':
          {
            completed = true;
            stop();
            associations.forEach(association => {
              association.discard((0, _messageHelper.cloneMessage)(message));
            });
            return broker.publish('execution', 'execute.discard', { ...messageContent
            });
          }

        case 'stop':
          {
            stop();
            break;
          }
      }
    }

    function stop() {
      broker.cancel(`_api-${executionId}`);
      broker.cancel(`_oncompensate-${executionId}`);
      broker.cancel('_oncollect-messages');
      broker.cancel('_convey-messages');
    }
  }

  function executeThrow(executeMessage) {
    const messageContent = (0, _messageHelper.cloneContent)(executeMessage.content);
    const {
      executionId,
      parent
    } = messageContent;
    const parentExecutionId = parent && parent.executionId;
    const {
      message: referenceMessage,
      description
    } = resolveMessage(executeMessage);
    debug(`<${executionId} (${id})> throw ${description}`);
    broker.publish('event', 'activity.compensate', { ...(0, _messageHelper.cloneContent)(messageContent),
      executionId: parentExecutionId,
      parent: (0, _messageHelper.shiftParent)(parent),
      message: { ...referenceMessage
      },
      state: 'throw'
    }, {
      type: 'compensate',
      delegate: true
    });
    return broker.publish('execution', 'execute.completed', { ...messageContent
    });
  }

  function resolveMessage(message) {
    if (!referenceElement) {
      return {
        message: { ...reference
        },
        description: 'anonymous compensation'
      };
    }

    const result = {
      message: referenceElement.resolve(message)
    };
    result.description = `${result.message.name} <${result.message.id}>`;
    return result;
  }

  function setupCatch() {
    broker.assertQueue(compensationQueueName, {
      autoDelete: false,
      durable: true
    });
    broker.bindQueue(compensationQueueName, 'api', '*.compensate.#', {
      durable: true,
      priority: 400
    });
  }
}