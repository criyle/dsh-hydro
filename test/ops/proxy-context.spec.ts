import { describe, expect, it } from 'vitest'

import { embeddedContextFromPath } from '../../src/ops/proxy.js'

describe('embeddedContextFromPath', () => {
  it('parses system problem paths without the /d/system prefix', () => {
    expect(embeddedContextFromPath('/p/P1000')).toMatchObject({
      kind: 'problem', domain: 'system', id: 'P1000', page: 'view',
    })
    expect(embeddedContextFromPath('/p/P1000/edit')).toMatchObject({
      kind: 'problem', domain: 'system', id: 'P1000', page: 'edit',
    })
    expect(embeddedContextFromPath('/p/P1000/files')).toMatchObject({
      kind: 'problem', domain: 'system', id: 'P1000', page: 'files',
    })
  })

  it('parses contest sub-pages for editing, management and clarifications', () => {
    expect(embeddedContextFromPath('/contest/abc')).toMatchObject({
      kind: 'contest', domain: 'system', id: 'abc', page: 'view',
    })
    expect(embeddedContextFromPath('/contest/abc/edit')).toMatchObject({ page: 'edit' })
    expect(embeddedContextFromPath('/contest/abc/management')).toMatchObject({ page: 'management' })
    expect(embeddedContextFromPath('/contest/abc/clarification')).toMatchObject({ page: 'clarification' })
    expect(embeddedContextFromPath('/contest/abc/problems')).toMatchObject({ page: 'problems' })
  })

  it('keeps the domain for /d/<domain>/ pages', () => {
    expect(embeddedContextFromPath('/d/class1/p/P42/edit')).toMatchObject({
      kind: 'problem', domain: 'class1', id: 'P42', page: 'edit',
    })
    expect(embeddedContextFromPath('/d/class1/contest/t1/management')).toMatchObject({
      kind: 'contest', domain: 'class1', id: 't1', page: 'management',
    })
  })

  it('recognises lists and domain edit pages', () => {
    expect(embeddedContextFromPath('/p')).toMatchObject({ kind: 'problem-list', domain: 'system' })
    expect(embeddedContextFromPath('/contest')).toMatchObject({ kind: 'contest-list', domain: 'system' })
    expect(embeddedContextFromPath('/d/system/p')).toMatchObject({ kind: 'problem-list', domain: 'system' })
    expect(embeddedContextFromPath('/d/system/contest')).toMatchObject({ kind: 'contest-list', domain: 'system' })
    expect(embeddedContextFromPath('/d/system/domain/edit')).toMatchObject({ kind: 'domain', page: 'edit' })
  })
})
