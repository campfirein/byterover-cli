import {expect} from 'chai'

import {
  TaskClearCompletedRequestSchema,
  TaskCreatedSchema,
  TaskDeleteBulkRequestSchema,
  TaskDeletedEventSchema,
  TaskDeleteRequestSchema,
  TaskGetRequestSchema,
  TaskGetResponseSchema,
  TaskListItemSchema,
  TaskListRequestSchema,
  TaskListResponseSchema,
} from '../../../../../src/server/core/domain/transport/schemas.js'

describe('task transport schemas', () => {
  describe('TaskListItemSchema', () => {
    const baseEntry = {
      content: 'test',
      createdAt: 1_745_432_123_456,
      status: 'completed' as const,
      taskId: 'abc-123',
      type: 'curate',
    }

    it('accepts entry with provider + model and preserves both fields', () => {
      const result = TaskListItemSchema.safeParse({
        ...baseEntry,
        model: 'gpt-5-pro',
        provider: 'openai',
      })
      expect(result.success).to.equal(true)
      if (result.success) {
        expect(result.data.provider).to.equal('openai')
        expect(result.data.model).to.equal('gpt-5-pro')
      }
    })

    it('accepts entry with provider only (ByteRover internal — no model)', () => {
      const result = TaskListItemSchema.safeParse({
        ...baseEntry,
        provider: 'byterover',
      })
      expect(result.success).to.equal(true)
      if (result.success) {
        expect(result.data.provider).to.equal('byterover')
        expect(result.data.model).to.equal(undefined)
      }
    })

    it('accepts entry without provider + model (back-compat)', () => {
      const result = TaskListItemSchema.safeParse(baseEntry)
      expect(result.success).to.equal(true)
      if (result.success) {
        expect(result.data.provider).to.equal(undefined)
        expect(result.data.model).to.equal(undefined)
      }
    })
  })

  describe('TaskCreatedSchema', () => {
    const baseCreated = {
      content: 'test',
      taskId: 'abc-123',
      type: 'curate' as const,
    }

    it('accepts payload with provider + model and preserves both fields', () => {
      const result = TaskCreatedSchema.safeParse({
        ...baseCreated,
        model: 'gpt-5-pro',
        provider: 'openai',
      })
      expect(result.success).to.equal(true)
      if (result.success) {
        expect(result.data.provider).to.equal('openai')
        expect(result.data.model).to.equal('gpt-5-pro')
      }
    })

    it('accepts payload with provider only (ByteRover internal — no model)', () => {
      const result = TaskCreatedSchema.safeParse({
        ...baseCreated,
        provider: 'byterover',
      })
      expect(result.success).to.equal(true)
      if (result.success) {
        expect(result.data.provider).to.equal('byterover')
        expect(result.data.model).to.equal(undefined)
      }
    })

    it('accepts payload without provider + model (back-compat)', () => {
      const result = TaskCreatedSchema.safeParse(baseCreated)
      expect(result.success).to.equal(true)
      if (result.success) {
        expect(result.data.provider).to.equal(undefined)
        expect(result.data.model).to.equal(undefined)
      }
    })
  })

  // ========================================================================
  // M2.16 — numbered pagination + filter/search
  // ========================================================================

  describe('TaskListRequest filter + numbered pagination (M2.16)', () => {
    it('accepts numbered pagination: page + pageSize', () => {
      const result = TaskListRequestSchema.safeParse({
        page: 2,
        pageSize: 50,
        projectPath: '/p',
      })
      expect(result.success).to.equal(true)
      if (result.success) {
        expect(result.data.page).to.equal(2)
        expect(result.data.pageSize).to.equal(50)
      }
    })

    it('rejects dropped cursor fields (before, beforeTaskId, limit)', () => {
      // Cursor pagination dropped entirely; these legacy fields must be rejected
      expect(TaskListRequestSchema.safeParse({before: 1_745_432_125_000}).success).to.equal(false)
      expect(TaskListRequestSchema.safeParse({beforeTaskId: 'abc'}).success).to.equal(false)
      expect(TaskListRequestSchema.safeParse({limit: 50}).success).to.equal(false)
    })

    it('enforces page >= 1', () => {
      expect(TaskListRequestSchema.safeParse({page: 1}).success).to.equal(true)
      expect(TaskListRequestSchema.safeParse({page: 0}).success).to.equal(false)
      expect(TaskListRequestSchema.safeParse({page: -1}).success).to.equal(false)
    })

    it('enforces pageSize bounds (1..1000)', () => {
      expect(TaskListRequestSchema.safeParse({pageSize: 1}).success).to.equal(true)
      expect(TaskListRequestSchema.safeParse({pageSize: 1000}).success).to.equal(true)
      expect(TaskListRequestSchema.safeParse({pageSize: 0}).success).to.equal(false)
      expect(TaskListRequestSchema.safeParse({pageSize: 1001}).success).to.equal(false)
    })

    it('accepts searchText', () => {
      const result = TaskListRequestSchema.safeParse({searchText: 'auth'})
      expect(result.success).to.equal(true)
      if (result.success) expect(result.data.searchText).to.equal('auth')
    })

    it('accepts provider + model arrays', () => {
      const result = TaskListRequestSchema.safeParse({
        model: ['gpt-5-pro'],
        provider: ['openai', 'anthropic'],
      })
      expect(result.success).to.equal(true)
      if (result.success) {
        expect(result.data.provider).to.deep.equal(['openai', 'anthropic'])
        expect(result.data.model).to.deep.equal(['gpt-5-pro'])
      }
    })

    it('accepts createdAfter + createdBefore (epoch ms)', () => {
      const result = TaskListRequestSchema.safeParse({
        createdAfter: 1_745_432_000_000,
        createdBefore: 1_745_432_999_999,
      })
      expect(result.success).to.equal(true)
      if (result.success) {
        expect(result.data.createdAfter).to.equal(1_745_432_000_000)
        expect(result.data.createdBefore).to.equal(1_745_432_999_999)
      }
    })

    it('accepts minDurationMs + maxDurationMs', () => {
      const result = TaskListRequestSchema.safeParse({
        maxDurationMs: 3_600_000,
        minDurationMs: 60_000,
      })
      expect(result.success).to.equal(true)
      if (result.success) {
        expect(result.data.minDurationMs).to.equal(60_000)
        expect(result.data.maxDurationMs).to.equal(3_600_000)
      }
    })

    it('Empty request still parses (all fields optional)', () => {
      expect(TaskListRequestSchema.safeParse({}).success).to.equal(true)
    })
  })

  describe('TaskListResponse numbered pagination + derivative sets (M2.16)', () => {
    const baseResp = {
      availableModels: [],
      availableProviders: [],
      counts: {all: 0, cancelled: 0, completed: 0, failed: 0, running: 0},
      page: 1,
      pageCount: 1,
      pageSize: 50,
      tasks: [],
      total: 0,
    }

    it('accepts numbered pagination response shape', () => {
      const result = TaskListResponseSchema.safeParse(baseResp)
      expect(result.success).to.equal(true)
    })

    it('rejects dropped cursor response fields (nextCursor, nextCursorTaskId)', () => {
      // Strict — cursor fields dropped entirely
      expect(TaskListResponseSchema.safeParse({...baseResp, nextCursor: 1000}).success).to.equal(false)
      expect(TaskListResponseSchema.safeParse({...baseResp, nextCursorTaskId: 'abc'}).success).to.equal(false)
    })

    it('counts requires all 5 status keys', () => {
      const incomplete = {...baseResp, counts: {all: 0, cancelled: 0, completed: 0, failed: 0}}
      expect(TaskListResponseSchema.safeParse(incomplete).success).to.equal(false)
    })

    it('counts values must be non-negative integers', () => {
      expect(
        TaskListResponseSchema.safeParse({
          ...baseResp,
          counts: {all: -1, cancelled: 0, completed: 0, failed: 0, running: 0},
        }).success,
      ).to.equal(false)
    })

    it('availableModels accepts (providerId, modelId) pair shape', () => {
      const result = TaskListResponseSchema.safeParse({
        ...baseResp,
        availableModels: [
          {modelId: 'gpt-5-pro', providerId: 'openai'},
          {modelId: 'claude-3-5-sonnet', providerId: 'anthropic'},
          {modelId: 'claude-3-5-sonnet', providerId: 'bedrock'},
        ],
      })
      expect(result.success).to.equal(true)
      if (result.success) expect(result.data.availableModels).to.have.lengthOf(3)
    })

    it('availableModels rejects plain string entries (must be pairs)', () => {
      const result = TaskListResponseSchema.safeParse({
        ...baseResp,
        availableModels: ['gpt-5-pro'],
      })
      expect(result.success).to.equal(false)
    })
  })

  describe('task:get', () => {
    it('TaskGet round-trips', () => {
      expect(TaskGetRequestSchema.safeParse({taskId: 'a'}).success).to.equal(true)
      expect(TaskGetResponseSchema.safeParse({task: null}).success).to.equal(true)

      const fullEntry = {
        completedAt: 1_745_432_002_000,
        content: 'x',
        createdAt: 1_745_432_000_000,
        id: 'tsk-1',
        model: 'gpt-5-pro',
        projectPath: '/p',
        provider: 'openai',
        result: 'done',
        schemaVersion: 1,
        startedAt: 1_745_432_001_000,
        status: 'completed',
        taskId: 'a',
        type: 'curate',
      }
      expect(TaskGetResponseSchema.safeParse({task: fullEntry}).success).to.equal(true)
    })
  })

  describe('task delete events', () => {
    it('TaskDelete / DeleteBulk / ClearCompleted parse valid shapes', () => {
      expect(TaskDeleteRequestSchema.safeParse({taskId: 'a'}).success).to.equal(true)
      expect(TaskDeleteBulkRequestSchema.safeParse({taskIds: ['a', 'b', 'c']}).success).to.equal(true)
      expect(TaskClearCompletedRequestSchema.safeParse({}).success).to.equal(true)
      expect(TaskClearCompletedRequestSchema.safeParse({projectPath: '/p'}).success).to.equal(true)
    })
  })

  describe('task:deleted broadcast', () => {
    it('TaskDeleted broadcast schema parses', () => {
      const result = TaskDeletedEventSchema.safeParse({taskId: 'a'})
      expect(result.success).to.equal(true)
      if (result.success) {
        expect(result.data.taskId).to.equal('a')
      }
    })
  })

})
