import { Ajv } from 'ajv'
import { RUNTIME_DOCUMENT_DIFF_SCHEMA } from '#core/runtime-control'
import { capabilityHash } from '#core/runtime-capability-projection'
import { renderV2Prompt, v2PromptManifest, V2_CONSTITUTION_PROMPT } from '#core/v2-prompts'
import type { ControlEnvelopeV2, RuntimeRequestBinding } from '#protocol/runtime-protocol'
import type { ContextPublishedProjection } from '#core/context-commit-store'
import type { AuxiliaryBudget } from '#core/runtime-auxiliary-store'
import type { LlmChatRequest } from '#util/llm'

const text = { type:'string',minLength:1,maxLength:2000 }
const refs = {type:'array',uniqueItems:true,maxItems:32,items:{type:'string',minLength:1}}
const object = (properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)})
const statement = object({statement:text,sourceRefs:refs})
export interface ReflectionOutput {
  reflectionVersion:1; snapshotId:string
  diagnosis:Array<{statement:string;sourceRefs:string[]}>
  correctionPlan:Array<{id:string;description:string;dependsOn:string[];verification:string;sourceRefs:string[]}>
  candidateDiffs:ControlEnvelopeV2['candidateDiffs']
  evidenceRequests:Array<{question:string;sourceRefs:string[]}>
  retryPreconditions:Array<{statement:string;sourceRefs:string[]}>
  uncertainties:Array<{statement:string;sourceRefs:string[]}>
}
export const REFLECTION_SCHEMA = object({
  reflectionVersion:{const:1},snapshotId:{type:'string',minLength:1},
  diagnosis:{type:'array',maxItems:16,items:statement},
  correctionPlan:{type:'array',maxItems:16,items:object({id:{type:'string',minLength:1},description:text,dependsOn:refs,verification:text,sourceRefs:refs})},
  candidateDiffs:{type:'array',items:RUNTIME_DOCUMENT_DIFF_SCHEMA,maxItems:16},
  evidenceRequests:{type:'array',maxItems:16,items:object({question:text,sourceRefs:refs})},
  retryPreconditions:{type:'array',maxItems:16,items:statement},uncertainties:{type:'array',maxItems:16,items:statement},
})
const validate = new Ajv({allErrors:true}).compile(REFLECTION_SCHEMA)
export interface ReflectionSource { id:string;kind:string;content:string;sourceHash:string;partial:boolean;totalCharacters:number }
export interface ReflectionInput {
  snapshotId:string;binding:RuntimeRequestBinding;contextHash:string;budget:AuxiliaryBudget;goal:string
  sources:ReflectionSource[];omittedSources:number;publications:ContextPublishedProjection[];runtimeState:unknown
  evidenceIndex:Array<{id:string;referenceId:string;sourceHash?:string;sessionId?:string}>
}
export function reflectionRequest(input:ReflectionInput):{request:LlmChatRequest;inputTokens:number;schemaHash:string;promptBindings:ReturnType<typeof v2PromptManifest>} {
  const prompt = renderV2Prompt('reflection',{
    reflection_binding_and_budget:{reflectionVersion:1,snapshotId:input.snapshotId,binding:input.binding,budget:input.budget},
    reflection_output_schema:REFLECTION_SCHEMA,
    original_goal_and_failure_receipts:{goal:input.goal,sources:input.sources},
    relevant_trace_and_context_diffs:{publications:input.publications,omittedSources:input.omittedSources,partialTrace:true},
    readonly_runtime_state_and_source_index:{runtimeState:input.runtimeState,sourceIds:input.sources.map(source=>source.id),evidenceIndex:input.evidenceIndex},
  })
  const request:LlmChatRequest={messages:[{role:'system',content:`${V2_CONSTITUTION_PROMPT}\n\n${prompt}`},{role:'user',content:'仅依据给定来源诊断。空缺保留为未知；不要执行纠正动作。'}],responseFormat:'json',maxTokens:input.budget.maxOutputTokens,
    clientMetadata:{sessionId:input.binding.sessionId,threadId:input.binding.sessionId,turnId:input.binding.runId}}
  return {request,inputTokens:Math.ceil(JSON.stringify(request).length/4),schemaHash:capabilityHash(REFLECTION_SCHEMA),promptBindings:v2PromptManifest(['constitution','reflection'])}
}
export function validateReflection(value:unknown,input:ReflectionInput):ReflectionOutput {
  if(!validate(value))throw new Error(`REFLECTION_SCHEMA_INVALID: ${validate.errors?.map(error=>`${error.instancePath} ${error.message}`).join('; ')}`)
  const result=value as unknown as ReflectionOutput
  if(result.snapshotId!==input.snapshotId)throw new Error('REFLECTION_SNAPSHOT_MISMATCH')
  const sources=new Set(input.sources.map(source=>source.id))
  const evidence=new Set(input.evidenceIndex.map(item=>item.id))
  for(const item of [...result.diagnosis,...result.correctionPlan,...result.evidenceRequests,...result.retryPreconditions,...result.uncertainties])
    if(item.sourceRefs.some(ref=>!sources.has(ref)))throw new Error('REFLECTION_SOURCE_UNKNOWN')
  if(result.diagnosis.some(item=>!item.sourceRefs.length))throw new Error('REFLECTION_DIAGNOSIS_EVIDENCE_REQUIRED')
  const ids=new Set(result.correctionPlan.map(item=>item.id))
  if(ids.size!==result.correctionPlan.length)throw new Error('REFLECTION_PLAN_DUPLICATE')
  const visited=new Set<string>(),visiting=new Set<string>()
  const visit=(id:string)=>{if(visiting.has(id))throw new Error('REFLECTION_PLAN_CYCLE');if(visited.has(id))return;visiting.add(id)
    const item=result.correctionPlan.find(item=>item.id===id);if(!item)throw new Error('REFLECTION_PLAN_DEPENDENCY_UNKNOWN');for(const dependency of item.dependsOn)visit(dependency);visiting.delete(id);visited.add(id)}
  for(const id of ids)visit(id)
  for(const diff of result.candidateDiffs){
    const publication=input.publications.find(publication=>publication.scope===diff.scope && publication.documentId===diff.documentId)
    const projection=publication?.projection
    if(!projection || diff.baseRevision!==projection.documentRevision || diff.projectionId!==projection.id || diff.projectionHash!==projection.contentHash
      || !projection.sourceCandidateIds.includes(diff.candidateId)
      || (diff.target.entryId && !projection.sourceEntryIds.includes(diff.target.entryId))
      || (diff.target.nodeId && !projection.treeNodes?.some(node=>node.id===diff.target.nodeId && node.hash===diff.targetNodeHash)))throw new Error('REFLECTION_DIFF_BINDING_INVALID')
    if(diff.payload.evidenceRefs?.some(id=>!evidence.has(id)))throw new Error('REFLECTION_EVIDENCE_UNKNOWN')
    if((diff.operation==='add_entry'||diff.operation==='replace_body')&&!diff.payload.body?.trim())throw new Error('REFLECTION_DIFF_BODY_REQUIRED')
    if(diff.operation==='replace_body'&&!diff.target.entryId)throw new Error('REFLECTION_DIFF_TARGET_REQUIRED')
    if(diff.operation==='append_evidence'&&!diff.payload.evidenceRefs?.length)throw new Error('REFLECTION_DIFF_EVIDENCE_REQUIRED')
    if(diff.operation==='mark_status'&&!diff.payload.status)throw new Error('REFLECTION_DIFF_STATUS_REQUIRED')
  }
  return result
}
