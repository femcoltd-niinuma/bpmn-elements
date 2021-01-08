import {ActivityError} from '../error/Errors';
import {cloneContent, cloneMessage} from '../messageHelper';
import {toSeconds, parse} from 'iso8601-duration';

export default function TimerEventDefinition(activity, eventDefinition) {
  const {id, broker, environment} = activity;
  const {type = 'TimerEventDefinition', behaviour = {}} = eventDefinition;

  let stopped = false;
  const logger = environment.Logger(type.toLowerCase());
  const {timeDuration, timeCycle, timeDate} = behaviour;
  const foundTimers = {
    ...(timeDuration ? {timeDuration} : undefined),
    ...(timeCycle ? {timeCycle} : undefined),
    ...(timeDate ? {timeDate} : undefined),
  };

  let timerRef;

  const source = {
    type,
    ...foundTimers,
    execute,
    stop() {
      if (timerRef) timerRef = environment.timers.clearTimeout(timerRef);
    },
  };

  Object.defineProperty(source, 'timer', {
    get() {
      return timerRef;
    },
  });

  return source;

  function execute(executeMessage) {
    if (timerRef) timerRef = environment.timers.clearTimeout(timerRef);
    stopped = false;

    const isResumed = executeMessage.fields && executeMessage.fields.redelivered;
    const {executionId} = executeMessage.content;

    if (isResumed && executeMessage.fields.routingKey !== 'execute.timer') {
      return logger.debug(`<${executionId} (${id})> resumed, waiting for timer message`);
    }

    const messageContent = executeMessage.content;
    const startedAt = 'startedAt' in messageContent ? new Date(messageContent.startedAt) : new Date();

    try {
      var resolvedTimer = getTimers(foundTimers, environment, executeMessage); // eslint-disable-line no-var
    } catch (err) {
      logger.error(`<${executionId} (${id})>`, err);
      return broker.publish('execution', 'execute.error', cloneContent(messageContent, {error: new ActivityError(err.message, executeMessage, err)}, {mandatory: true}));
    }

    const timerContent = cloneContent(messageContent, {
      ...resolvedTimer,
      ...(isResumed ? {isResumed} : undefined),
      startedAt,
      state: 'timer',
    });

    broker.subscribeTmp('api', `activity.#.${executionId}`, onApiMessage, {noAck: true, consumerTag: `_api-${executionId}`, priority: 400});
    broker.subscribeTmp('api', '#.cancel.*', onDelegatedApiMessage, {noAck: true, consumerTag: `_api-delegated-${executionId}`});

    broker.publish('execution', 'execute.timer', timerContent);
    broker.publish('event', 'activity.timer', cloneContent(timerContent));

    if (stopped) return;

    if (timerContent.timeout === undefined) return logger.debug(`<${executionId} (${id})> waiting for ${timerContent.timerType || 'signal'}`);
    if (timerContent.timeout <= 0) return completed();

    const timers = environment.timers.register(timerContent);

    timerRef = timers.setTimeout(completed, timerContent.timeout, cloneMessage(executeMessage, timerContent));

    function completed(completeContent, options) {
      stop();

      const stoppedAt = new Date();

      const runningTime = stoppedAt.getTime() - startedAt.getTime();
      logger.debug(`<${executionId} (${id})> completed in ${runningTime}ms`);

      const completedContent = {...timerContent, stoppedAt, runningTime, state: 'timeout', ...completeContent};

      broker.publish('event', 'activity.timeout', cloneContent(messageContent, completedContent), options);
      broker.publish('execution', 'execute.completed', cloneContent(messageContent, completedContent), options);
    }

    function onDelegatedApiMessage(routingKey, message) {
      if (!message.properties.delegate) return;
      const {content: delegateContent} = message;
      if (!delegateContent.message) return;

      const {id: signalId, executionId: signalExecutionId} = delegateContent.message;
      if (signalId !== id && signalExecutionId !== executionId) return;
      if (signalExecutionId && signalId === id && signalExecutionId !== executionId) return;

      const {type: messageType, correlationId} = message.properties;
      broker.publish('event', 'activity.consumed', cloneContent(timerContent, {message: {...delegateContent.message}}), {correlationId, type: messageType});
      return onApiMessage(routingKey, message);
    }

    function onApiMessage(routingKey, message) {
      const {type: messageType, correlationId} = message.properties;

      switch (messageType) {
        case 'cancel': {
          stop();
          return completed({
            state: 'cancel',
            ...(message.content.message ? {message: message.content.message} : undefined),
          }, {correlationId});
        }
        case 'stop': {
          stop();
          return logger.debug(`<${executionId} (${id})> stopped`);
        }
        case 'discard': {
          stop();
          logger.debug(`<${executionId} (${id})> discarded`);
          return broker.publish('execution', 'execute.discard', cloneContent(timerContent, {state: 'discard'}), {correlationId});
        }
      }
    }

    function stop() {
      stopped = true;
      if (timerRef) timerRef = environment.timers.clearTimeout(timerRef);
      broker.cancel(`_api-${executionId}`);
      broker.cancel(`_api-delegated-${executionId}`);
    }
  }
}

function getTimers(timers, environment, executionMessage) {
  const content = executionMessage.content;

  let expireAt;
  if ('expireAt' in content) {
    expireAt = new Date(content.expireAt);
  }

  const now = Date.now();

  const timerContent = ['timeDuration', 'timeDate', 'timeCycle'].reduce((result, t) => {
    if (t in content) result[t] = content[t];
    else if (t in timers) result[t] = environment.resolveExpression(timers[t], executionMessage);
    else return result;

    let expireAtDate;
    switch (t) {
      case 'timeDuration': {
        const durationStr = result[t];
        if (durationStr) {
          const delay = toSeconds(parse(durationStr)) * 1000;
          expireAtDate = new Date(now + delay);
        } else {
          expireAtDate = new Date(now);
        }
        break;
      }
      case 'timeDate': {
        const dateStr = result[t];
        if (dateStr) {
          const ms = Date.parse(dateStr);
          if (isNaN(ms)) throw new Error(`invalid timeDate >${dateStr}<`);
          expireAtDate = new Date(ms);
        } else {
          expireAtDate = new Date(now);
        }
        break;
      }
    }

    if (!expireAtDate) return result;

    if (!('expireAt' in result) || result.expireAt > expireAtDate) {
      result.timerType = t;
      result.expireAt = expireAtDate;
    }

    return result;
  }, {
    ...(expireAt ? {expireAt} : undefined),
  });

  if ('expireAt' in timerContent) {
    timerContent.timeout = timerContent.expireAt - now;
  } else if ('timeout' in content) {
    timerContent.timeout = content.timeout;
  } else if (!Object.keys(timerContent).length) {
    timerContent.timeout = 0;
  }

  return timerContent;
}
