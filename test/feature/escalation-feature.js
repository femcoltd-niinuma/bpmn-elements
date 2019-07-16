import CamundaExtension from '../resources/extensions/CamundaExtension';
import Definition from '../../src/definition/Definition';
import factory from '../helpers/factory';
import testHelpers from '../helpers/testHelpers';

const escalationSource = factory.resource('escalation.bpmn');

Feature('Escalate', () => {
  Scenario('a process with escalation events', () => {
    let definition;
    Given('a subprocess that escalates with signal if order amount is greater than treshold', async () => {
      definition = await prepareSource();
    });

    let signal, escalate, end;
    When('definition is ran', () => {
      signal = definition.waitFor('signal');
      escalate = definition.waitFor('activity.escalate');
      end = definition.waitFor('end');
      definition.run();
    });

    let orderProcess, escalated;
    Then('escalation is monitored', () => {
      [escalated, orderProcess] = definition.getPostponed();
      expect(escalated.content).to.have.property('escalation').that.eql({
        id: 'AmountEscalation',
        type: 'bpmn:Escalation',
        name: 'Escalate amount too big',
      });
    });

    And('amount above treshold is ordered', () => {
      const [, orderTask] = orderProcess.getPostponed();
      expect(orderTask).to.be.ok;
      expect(orderTask.content.form).to.have.property('fields');
      orderTask.signal({
        form: {
          amount: 11
        }
      });
    });

    Then('amount is escalated', async () => {
      await escalate;
      expect(escalated.owner.counters).to.have.property('taken', 1);
    });

    And('signal is sent', async () => {
      const endSignal = await signal;
      expect(endSignal.owner.counters).to.have.property('completed', 1);
      expect(endSignal.content).to.have.property('message').that.deep.include({
        id: 'EscalatedSignal',
        type: 'bpmn:Signal',
        name: 'Too big signal',
        parent: {
          id: 'Definition_0',
          type: 'bpmn:Definitions',
        }
      });
    });

    And('run is completed', async () => {
      return end;
    });
  });

  Scenario('a process with start escalation event', () => {
    let definition;
    Given('escalate event, an escalation manager sub process, a boss that expects not to be bothered, and a anonymous signal process', async () => {
      const source = `
      <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="escalateProcess" isExecutable="true">
          <subProcess id="escalateSubProcess">
            <intermediateThrowEvent id="escalateAnonymous">
              <escalationEventDefinition />
            </intermediateThrowEvent>
            <subProcess id="manager" triggeredByEvent="true">
              <startEvent id="wakeManager" isInterrupting="false">
                <escalationEventDefinition />
              </startEvent>
            </subProcess>
          </subProcess>
          <boundaryEvent id="boss" attachedToRef="escalateSubProcess">
            <escalationEventDefinition />
          </boundaryEvent>
        </process>
        <process id="signalProcess">
          <startEvent id="startWithAnonymousSignal">
            <signalEventDefinition />
          </startEvent>
        </process>
      </definitions>`;

      const context = await testHelpers.context(source);
      definition = Definition(context);
    });

    let end, caught;
    When('definition is ran', () => {
      end = definition.waitFor('end');
      caught = definition.waitFor('activity.catch');
      definition.run();
    });

    let escalateProcess, signalProcess;
    Then('run completes', async () => {
      [escalateProcess, signalProcess] = definition.getProcesses();
      await end;
    });

    And('escalate process completed', () => {
      expect(escalateProcess.counters).to.have.property('completed', 1);
    });

    And('manager is notified', async () => {
      const manager = await caught;
      expect(manager).to.have.property('id', 'wakeManager');
      expect(manager.owner.counters).to.have.property('taken', 1);
    });

    And('the boss is not bothered', () => {
      const boss = definition.getElementById('boss');
      expect(boss.counters).to.have.property('discarded', 1);
      expect(boss.counters).to.have.property('taken', 0);
    });

    And('the signal process is not touched', () => {
      expect(signalProcess.counters).to.have.property('completed', 0);
    });
  });

  Scenario('a process with nested escalation', () => {
    let definition;
    Given('a boss that expects to be bothered only if manager doesn´t react in time', async () => {
      const source = `
      <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="escalateProcess" isExecutable="true">
          <subProcess id="escalateSubProcess">
            <intermediateThrowEvent id="notifyManager">
              <escalationEventDefinition escalationRef="level0"/>
            </intermediateThrowEvent>

            <subProcess id="escalateManager" triggeredByEvent="true">
              <startEvent id="wakeManager" isInterrupting="false">
                <escalationEventDefinition escalationRef="level0" />
              </startEvent>
              <sequenceFlow id="toSplit" sourceRef="wakeManager" targetRef="split"/>
              <eventBasedGateway id="split" />
              <sequenceFlow id="toCall" sourceRef="split" targetRef="call"/>
              <sequenceFlow id="toTimeout" sourceRef="split" targetRef="timeout"/>
              <userTask id="call" />
              <intermediateThrowEvent id="timeout">
                <timerEventDefinition>
                  <timeDuration xsi:type="tFormalExpression">PT0.01S</timeDuration>
                </timerEventDefinition>
              </intermediateThrowEvent>
              <sequenceFlow id="toEscalateToBoss" sourceRef="timeout" targetRef="notifyBoss"/>
              <intermediateThrowEvent id="notifyBoss">
                <escalationEventDefinition escalationRef="level1" />
              </intermediateThrowEvent>
            </subProcess>

            <subProcess id="escalateToBoss" triggeredByEvent="true">
              <startEvent id="wakeBoss" isInterrupting="false">
                <escalationEventDefinition escalationRef="level1" />
              </startEvent>
            </subProcess>
          </subProcess>
        </process>
        <escalation id="level0" name="Escalate to manager" />
        <escalation id="level1" name="Escalate to boss" />
      </definitions>`;

      const context = await testHelpers.context(source);
      definition = Definition(context);
    });

    let end, timeout;
    const caught = [];
    When('definition is ran', () => {
      timeout = definition.waitFor('activity.timeout');
      definition.on('activity.catch', (api) => {
        caught.push(api);
      });
      end = definition.waitFor('end');
      definition.run();
    });

    Given('manager is late', () => {
      return timeout;
    });

    Then('run completes', async () => {
      await end;
      expect(caught).to.have.length(2);
    });

    And('manager was notified', async () => {
      const manager = caught[0];
      expect(manager).to.have.property('id', 'wakeManager');
      expect(manager.owner.counters).to.have.property('taken', 1);
      expect(manager.owner.counters).to.have.property('discarded', 0);
    });

    And('the boss is notified', () => {
      const boss = caught[1];
      expect(boss).to.have.property('id', 'wakeBoss');
      expect(boss.owner.counters).to.have.property('taken', 1);
      expect(boss.owner.counters).to.have.property('discarded', 0);
    });
  });

  Scenario('a process with caught escalation', () => {
    let definition;
    Given('a boss that expects to be bothered only if escalation was not caught', async () => {
      const source = `
      <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="escalateProcess" isExecutable="true">
          <subProcess id="escalateSubProcess">
            <intermediateThrowEvent id="notifyManager">
              <escalationEventDefinition escalationRef="level0"/>
            </intermediateThrowEvent>

            <subProcess id="escalateManager" triggeredByEvent="true">
              <startEvent id="wakeManager" isInterrupting="false">
                <escalationEventDefinition escalationRef="level0" />
              </startEvent>
            </subProcess>
          </subProcess>
          <boundaryEvent id="wakeBoss" attachedToRef="escalateSubProcess">
            <escalationEventDefinition />
          </boundaryEvent>
        </process>
        <escalation id="level0" name="Escalate to manager" />
      </definitions>`;

      const context = await testHelpers.context(source);
      definition = Definition(context);
    });

    let end, caught, bp;
    When('definition is ran', () => {
      caught = definition.waitFor('activity.catch');
      end = definition.waitFor('end');
      definition.run();
    });

    let manager;
    Given('manager reacts', async () => {
      manager = await caught;
    });

    Then('run completes', async () => {
      [bp] = definition.getProcesses();
      await end;
    });

    And('manager was notified', async () => {
      expect(manager).to.have.property('id', 'wakeManager');
      expect(manager.owner.counters).to.have.property('taken', 1);
      expect(manager.owner.counters).to.have.property('discarded', 0);
    });

    And('the boss was left sleeping', () => {
      const boss = bp.getActivityById('wakeBoss');
      expect(boss.counters).to.have.property('discarded', 1);
      expect(boss.counters).to.have.property('taken', 0);
    });
  });

  Scenario('a process with uncaught escalation', () => {
    let definition;
    Given('a boss that expects to be bothered only if escalation was not caught', async () => {
      const source = `
      <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="escalateProcess" isExecutable="true">
          <subProcess id="escalateSubProcess">
            <intermediateThrowEvent id="escalate">
              <escalationEventDefinition />
            </intermediateThrowEvent>

            <subProcess id="escalateManager" triggeredByEvent="true">
              <startEvent id="wakeManager" isInterrupting="false">
                <escalationEventDefinition escalationRef="level0" />
              </startEvent>
            </subProcess>
          </subProcess>
          <boundaryEvent id="wakeBoss" attachedToRef="escalateSubProcess" cancelActivity="false">
            <escalationEventDefinition />
          </boundaryEvent>
        </process>
        <escalation id="level0" name="Escalate to manager" />
      </definitions>`;

      const context = await testHelpers.context(source);
      definition = Definition(context);
    });

    let end, caught, bp;
    When('definition is ran', () => {
      caught = definition.waitFor('activity.catch');
      end = definition.waitFor('end');
      definition.run();
    });

    let boss;
    Given('no-one reacts except the boss', async () => {
      boss = await caught;
    });

    Then('run completes', async () => {
      [bp] = definition.getProcesses();
      await end;
    });

    And('escalating process completed', () => {
      const subProcess = bp.getActivityById('escalateSubProcess');
      expect(subProcess.counters).to.have.property('taken', 1);
      expect(subProcess.counters).to.have.property('discarded', 0);
    });

    And('boss was not notified', async () => {
      expect(boss).to.have.property('id', 'wakeBoss');
      expect(boss.owner.counters).to.have.property('taken', 1);
      expect(boss.owner.counters).to.have.property('discarded', 0);
    });
  });
});

async function prepareSource() {
  const context = await testHelpers.context(escalationSource, {
    extensions: {
      camunda: CamundaExtension
    }
  });
  return Definition(context, {
    services: {
      isAbove(treshold, value) {
        return parseInt(treshold) < parseInt(value);
      },
    }
  });
}
