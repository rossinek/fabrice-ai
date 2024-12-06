import prompt from 'dedent'
import OpenAI from 'openai'
import { zodFunction, zodResponseFormat } from 'openai/helpers/zod'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { z } from 'zod'

// tbd: abstract this away or not? most APIs are OpenAI compatible
const openai = new OpenAI()

interface Protocol {
  requestUserInput(prompt: string): Promise<string>
}

// tbd: we should replace this with a "HumanInTheLoop" agent of CLI type
// to do so, we need to implement delegation across different agents
// so they can work collaboratively on smaller tasks too
class CLIProtocol implements Protocol {
  async requestUserInput(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      console.log(prompt)
      process.stdin.once('data', (data) => {
        resolve(data.toString().trim())
      })
    })
  }
}

type ToolDefinition<T extends z.ZodObject<{}>> = {
  name: string
  description: string
  parameters: T
  execute: (parameters: z.infer<T>) => Promise<string>
}

interface AgentConfig {
  prompt?: string
  tools?: ToolDefinition<any>[]
  model?: string
  protocol?: Protocol
}

// tbd: implement delegation
// tbd: implement short-term and long-term memory with different storage models
export class Agent {
  private prompt: string
  private tools: ToolDefinition<any>[]
  private model: string
  private protocol: Protocol

  constructor({
    prompt = '',
    tools = [],
    model = 'gpt-4o',
    protocol = new CLIProtocol(),
  }: AgentConfig = {}) {
    this.prompt = prompt
    this.tools = tools
    this.model = model
    this.protocol = protocol
  }

  async executeTask(
    messages: Message[],
    delegate: (task: string) => Promise<Message[]>
  ): Promise<string> {
    const response = await openai.beta.chat.completions.parse({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: prompt`
            ${this.prompt}
            
            Your job is to complete the assigned task.
            1. Break down the task into steps
            2. Use available tools when needed
            3. Provide clear progress updates
            
            If the task requires tools, expertise, or input you lack, send a delegation request to your Supervisor
          `,
        },
        ...messages,
      ],
      // tbd: only add tools if there are any
      tools: this.tools.length > 0 ? this.tools.map(zodFunction) : undefined,
      response_format: zodResponseFormat(
        z.object({
          response: z.discriminatedUnion('kind', [
            z.object({
              kind: z.literal('delegate'),
              task: z.string().describe('The task to delegate to another agent'),
              reasoning: z.string().describe('The reasoning for delegating the task'),
            }),
            z.object({
              kind: z.literal('complete'),
              result: z.string().describe('The final result of the task'),
              reasoning: z.string().describe('The reasoning for completing the task'),
            }),
          ]),
        }),
        'task_result'
      ),
    })
    if (response.choices[0].message.tool_calls.length > 0) {
      const toolResults = await Promise.all(
        response.choices[0].message.tool_calls.map(async (toolCall) => {
          if (toolCall.type !== 'function') {
            throw new Error('Tool call is not a function')
          }

          const tool = this.tools.find((t) => t.name === toolCall.function.name)
          if (!tool) {
            throw new Error(`Unknown tool: ${toolCall.function.name}`)
          }

          const parameters = tool.parameters.parse(toolCall.function.arguments)
          const content = await tool.execute(parameters)

          return {
            role: 'tool' as const,
            tool_call_id: toolCall.id,
            content: JSON.stringify(content),
          }
        })
      )

      return this.executeTask([...messages, response.choices[0].message, ...toolResults], delegate)
    }

    // tbd: verify shape of response
    const result = response.choices[0].message.parsed
    if (!result) {
      throw new Error('No parsed response received')
    }

    if (result.response.kind === 'delegate') {
      const delegatedWorkflow = await delegate(result.response.task)
      return this.executeTask(
        [
          ...messages,
          {
            role: 'assistant',
            content: prompt`
              Delegating task: "${result.response.task}"
              Reason for delegation: "${result.response.reasoning}"
            `,
          },
          ...delegatedWorkflow,
        ],
        delegate
      )
    }

    if (result.response.kind === 'complete') {
      return result.response.result
    }

    // tbd: check if this is reachable
    throw new Error('Illegal state')
  }

  async requestUserInput(prompt: string): Promise<string> {
    return this.protocol.requestUserInput(prompt)
  }

  toString(): string {
    return this.prompt
  }
}

type Message = ChatCompletionMessageParam

class Supervisor {
  private agents: Agent[] = []

  constructor(agents: Agent[]) {
    this.agents = agents
  }

  async executeWorkflow(workflow: Message[]): Promise<Message[]> {
    // tbd: set reasonable max iterations
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const task = await getNextTask(workflow)

      if (!task) {
        return workflow
      }

      workflow.push({
        role: 'assistant',
        content: task,
      })

      // tbd: this throws, handle it
      const selectedAgent = await selectAgent(task, this.agents)

      // tbd: this should just be a try/catch
      // tbd: do not return string, but more information or keep memory in agent
      try {
        const result = await selectedAgent.executeTask(
          [
            {
              role: 'user',
              content: task,
            },
          ],
          async (delegateTask) => {
            return this.executeWorkflow([
              {
                role: 'assistant',
                content: delegateTask,
              },
            ])
          }
        )
        workflow.push({
          role: 'assistant',
          content: result,
        })
      } catch (error) {
        workflow.push({
          role: 'assistant',
          content: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }
  }
}

export class Team {
  private agents: Agent[]
  private supervisor: Supervisor

  constructor({ agents = [] }: { agents: Agent[] }) {
    this.agents = agents
    this.supervisor = new Supervisor(agents)
  }

  async ask(workflow: string): Promise<void> {
    await this.supervisor.executeWorkflow([
      {
        role: 'user',
        content: workflow,
      },
    ])
  }
}

async function selectAgent(task: string, agents: Agent[]): Promise<Agent> {
  const response = await openai.beta.chat.completions.parse({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: prompt`
          You are an agent selector that matches tasks to the most capable agent.
          Analyze the task requirements and each agent's capabilities to select the best match.
          
          Consider:
          1. Required tools and skills
          2. Agent's specialization
          3. Model capabilities
          4. Previous task context if available
        `,
      },
      {
        // tbd: we need role, experience etc., for agent, and to stringify this array properly, otherwise it doesn't know which one to choose
        role: 'user',
        content: prompt`
          Task:
          ${task}

          Available agents:
          ${agents}

          Select the most suitable agent for this task.
        `,
      },
    ],
    temperature: 0.1,
    response_format: zodResponseFormat(
      z.object({
        agentIndex: z.number(),
        reasoning: z.string(),
      }),
      'agent_selection'
    ),
  })

  const content = response.choices[0].message.parsed
  if (!content) {
    throw new Error('No content in response')
  }

  const agent = agents[content.agentIndex]
  if (!agent) {
    throw new Error('Invalid agent')
  }

  return agent
}

async function getNextTask(history: Message[]): Promise<string | null> {
  const response = await openai.beta.chat.completions.parse({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        // tbd: improve prompt for generic workflow
        // tbd: handle subsequent failures
        content: prompt`
          You are a workflow planner that breaks down complex tasks into smaller, actionable steps.
          Your job is to determine the next task that needs to be done based on the original workflow and what has been completed so far.
          If all required tasks are completed, return null.

          Rules:
          1. Each task should be self-contained and achievable
          2. Tasks should be specific and actionable
          3. Return null when the workflow is complete
          4. Consider dependencies and order of operations
          5. Use context from completed tasks to inform next steps
        `,
      },
      ...history,
      {
        role: 'user',
        content: 'What is the next task that needs to be done?',
      },
    ],
    temperature: 0.2,
    response_format: zodResponseFormat(
      z.object({
        task: z
          .string()
          .describe('The next task to be completed or null if the workflow is complete'),
        reasoning: z
          .string()
          .describe('The reasoning for selecting the next task or why the workflow is complete'),
      }),
      'next_task'
    ),
  })

  try {
    const content = response.choices[0].message.parsed
    if (!content) {
      throw new Error('No content in response')
    }

    if (!content.task) {
      return null
    }

    return content.task
  } catch (error) {
    throw new Error('Failed to determine next task')
  }
}

// tbd: integrate telemetry
function debug(...args: any[]) {
  console.log('🐞', ...args)
}
