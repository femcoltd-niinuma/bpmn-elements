import factory from '../helpers/factory';
import testHelpers from '../helpers/testHelpers';

describe('IntermediateCatchEvent', () => {
  it('without event definitions completes immediately', async () => {
    const source = `
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <process id="theProcess" isExecutable="true">
        <intermediateCatchEvent id="emptyEvent" />
      </process>
    </definitions>`;

    const context = await testHelpers.context(source);
    const event = context.getActivityById('emptyEvent');
    const leave = event.waitFor('leave');

    event.run();

    await leave;

    expect(event.counters).to.have.property('taken', 1);
  });

  describe('with event definitions', () => {
    let context;
    beforeEach(async () => {
      const source = `
      <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <intermediateCatchEvent id="event">
            <messageEventDefinition />
            <timerEventDefinition>
              <timeDuration xsi:type="tFormalExpression">\${environment.variables.duration}</timeDuration>
            </timerEventDefinition>
          </intermediateCatchEvent>
        </process>
      </definitions>`;
      context = await testHelpers.context(source);
      context.environment.variables.duration = 'PT2S';
    });

    it('discards pending event definitions when event completes', async () => {
      const event = context.getActivityById('event');

      const messages = [];
      event.broker.subscribeTmp('execution', 'execute.*', (routingKey, message) => {
        messages.push(message);
      }, {noAck: true});

      const wait = event.waitFor('wait');
      const leave = event.waitFor('leave');

      event.run();

      const api = await wait;
      api.signal();

      await leave;

      const discarded = messages.filter(({fields}) => fields.routingKey === 'execute.discard');
      expect(discarded.map(({content}) => content.type)).to.have.same.members(['bpmn:TimerEventDefinition']);
    });

    it('discards all event definitions if discarded while executing', async () => {
      const event = context.getActivityById('event');

      const messages = [];
      event.broker.subscribeTmp('execution', 'execute.*', (routingKey, message) => {
        messages.push(message);
      }, {noAck: true});

      const wait = event.waitFor('wait');
      const leave = event.waitFor('leave');

      event.run();

      await wait;
      event.getApi().discard();

      await leave;

      const discarded = messages.filter(({fields}) => fields.routingKey === 'execute.discard');
      expect(discarded.map(({content}) => content.type)).to.have.same.members(['bpmn:IntermediateCatchEvent', 'bpmn:MessageEventDefinition', 'bpmn:TimerEventDefinition']);
    });
  });

  describe('with timer event definition', () => {
    const source = `
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <process id="theProcess" isExecutable="true">
        <startEvent id="start" />
        <sequenceFlow id="flow1" sourceRef="start" targetRef="timeoutEvent" />
        <intermediateCatchEvent id="timeoutEvent">
          <timerEventDefinition>
            <timeDuration xsi:type="tFormalExpression">\${environment.variables.duration}</timeDuration>
          </timerEventDefinition>
        </intermediateCatchEvent>
        <sequenceFlow id="flow2" sourceRef="timeoutEvent" targetRef="end" />
        <endEvent id="end" />
      </process>
    </definitions>`;

    let context;
    beforeEach(async () => {
      context = await testHelpers.context(source);
      context.environment.variables.duration = 'PT0.01S';
    });

    it('completes when timeout occur', async () => {
      const event = context.getActivityById('timeoutEvent');

      const leave = event.waitFor('leave');

      event.run();

      await leave;

      expect(event.counters).to.have.property('taken', 1);
    });

    it('is discarded if discarded while executing', async () => {
      context.environment.variables.duration = 'PT2S';

      const event = context.getActivityById('timeoutEvent');

      const leave = event.waitFor('leave');
      const timer = event.waitFor('timer');

      event.run();

      const api = await timer;
      api.discard();

      await leave;

      expect(event.counters).to.have.property('discarded', 1);
    });
  });

  describe('with message event definition', () => {
    const source = `
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <process id="theProcess" isExecutable="true">
        <startEvent id="start" />
        <sequenceFlow id="flow1" sourceRef="start" targetRef="event" />
        <intermediateCatchEvent id="event">
          <messageEventDefinition />
        </intermediateCatchEvent>
        <sequenceFlow id="flow2" sourceRef="event" targetRef="end" />
        <endEvent id="end" />
      </process>
    </definitions>`;

    let context;
    beforeEach(async () => {
      context = await testHelpers.context(source);
    });

    it('completes when wait event api is signaled', async () => {
      const event = context.getActivityById('event');

      const leave = event.waitFor('leave');
      const wait = event.waitFor('wait');

      event.run();

      const api = await wait;

      api.signal();

      await leave;

      expect(event.counters).to.have.property('taken', 1);
    });

    it('completes when parent event api is signaled', async () => {
      const event = context.getActivityById('event');

      const leave = event.waitFor('leave');
      const wait = event.waitFor('wait');

      event.run();

      await wait;

      event.getApi().signal({data: 1});

      await leave;

      expect(event.counters).to.have.property('taken', 1);
    });
  });

  describe('IntermediateCatchEvent in lanes', () => {
    let context;
    before(async () => {
      context = await testHelpers.context(factory.resource('lanes.bpmn').toString());
    });

    it('completes when message is received after execute', async () => {
      const event = context.getActivityById('intermediate');

      event.activate();

      const leave = event.waitFor('leave');
      event.inbound[0].take();

      event.message({});

      await leave;

      expect(event.broker.getQueue('messages').consumerCount).to.equal(0);
      expect(event.broker.getQueue('messages').messageCount).to.equal(0);
    });

    it('completes when message is received before execution', async () => {
      const event = context.getActivityById('intermediate');
      event.activate();

      event.message({});
      expect(event.broker.getQueue('messages').messageCount).to.equal(1);

      const leave = event.waitFor('leave');
      event.inbound[0].take();


      await leave;
    });
  });

  describe('with conditional event definition', () => {
    const source = `
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <process id="theProcess" isExecutable="true">
        <startEvent id="start" />
        <sequenceFlow id="flow1" sourceRef="start" targetRef="event" />
        <intermediateCatchEvent id="event">
          <conditionalEventDefinition>
            <condition xsi:type="tFormalExpression">\${environment.variables.conditionMet}</condition>
          </conditionalEventDefinition>
        </intermediateCatchEvent>
        <sequenceFlow id="flow2" sourceRef="event" targetRef="end" />
        <endEvent id="end" />
      </process>
    </definitions>`;

    let context;
    beforeEach(async () => {
      context = await testHelpers.context(source);
    });

    it('completes when event is signaled and condition is met', async () => {
      const event = context.getActivityById('event');

      const leave = event.waitFor('leave');
      const wait = event.waitFor('wait');

      event.run();

      const api = await wait;

      event.environment.variables.conditionMet = true;
      api.signal();

      await leave;

      expect(event.counters).to.have.property('taken', 1);
    });

    it('completes when parent event api is signaled', async () => {
      const event = context.getActivityById('event');

      const leave = event.waitFor('leave');
      const wait = event.waitFor('wait');

      event.run();

      await wait;

      event.environment.variables.conditionMet = true;
      event.getApi().signal({data: 1});

      await leave;

      expect(event.counters).to.have.property('taken', 1);
    });

    it('keeps waiting if condition is not met', async () => {
      const event = context.getActivityById('event');
      const wait = event.waitFor('wait');

      event.run();

      await wait;

      event.getApi().signal({data: 1});

      expect(event.counters).to.have.property('taken', 0);
    });

    it('completes immediately if condition is met on execute', async () => {
      context.environment.variables.conditionMet = true;
      const event = context.getActivityById('event');

      const leave = event.waitFor('leave');
      event.run();

      await leave;

      expect(event.counters).to.have.property('taken', 1);
    });
  });
});
