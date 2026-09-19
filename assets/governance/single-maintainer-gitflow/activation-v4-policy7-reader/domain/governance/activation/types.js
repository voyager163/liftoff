export const phaseIds = [
  'seed-valid',
  'seed-verified',
  'seed-archived',
  'committed',
  'pushed',
  'repository-discovered',
  'repository-workflow-source-ready',
  'repository-checks-qualified',
  'repository-enforcement-approved',
  'repository-rulesets-applied',
  'repository-live-readback',
  'phase-0-complete',
  'activation-approved',
  'bootstrap-workflow-source-ready',
  'credential-ready',
  'provider-ready',
  'state-path-selected',
  'existing-private-path',
  'bootstrap-local',
  'runner-ready',
  'private-backend-proof',
  'remote-import-verified',
  'remote-ready',
  'application-prerequisites-ready',
  'workflow-source-ready',
  'application-artifact-ready',
  'application-foundation',
  'dev-proof',
  'staging-qualified',
  'production-rehearsed',
  'green-red-proof',
  'enforcement-approved',
  'rulesets-applied',
  'live-readback',
  'bootstrap-state-disposed'
]         ;

                                              

export const governanceScopes = ['local', 'repository', 'activation', 'lifecycle']         ;
                                                              

export const localSetupPhaseIds = ['seed-valid', 'seed-verified', 'seed-archived']                                      ;
export const lifecyclePhaseIds = ['bootstrap-state-disposed']                                      ;
export const sharedPublicationPhaseIds = ['committed', 'pushed']                                      ;
export const repositoryPhaseIds = [
  'repository-discovered', 'repository-workflow-source-ready', 'repository-checks-qualified',
  'repository-enforcement-approved', 'repository-rulesets-applied', 'repository-live-readback'
]                                      ;
export const activationPhaseIds                     = phaseIds.filter((id) =>
  !(localSetupPhaseIds                      ).includes(id) && !(lifecyclePhaseIds                      ).includes(id) &&
  !(repositoryPhaseIds                      ).includes(id)
);

export function phaseScope(phaseId         )                  {
  if ((localSetupPhaseIds                      ).includes(phaseId)) return 'local';
  if ((repositoryPhaseIds                      ).includes(phaseId)) return 'repository';
  if ((lifecyclePhaseIds                      ).includes(phaseId)) return 'lifecycle';
  return 'activation';
}

export function phaseInScope(phaseId         , scope                 , prerequisites = false)          {
  if (phaseScope(phaseId) === scope) return true;
  if (scope === 'repository' && (sharedPublicationPhaseIds                      ).includes(phaseId)) return true;
  return prerequisites && (scope === 'activation' || scope === 'repository') &&
    (localSetupPhaseIds                      ).includes(phaseId);
}

export const phaseStates = [
  'pending',
  'blocked',
  'ready',
  'approved',
  'running',
  'verified',
  'failed',
  'inapplicable',
  'retained',
  'disposed'
]         ;

                                                    
                                         
             
                                                                               
  

export const mutationClasses = [
  'none',
  'read-worktree',
  'write-activation-state',
  'write-evidence',
  'write-openspec-seed',
  'write-seed-tasks',
  'project-governance-tasks',
  'write-openspec-governance',
  'write-local-state',
  'delete-local-state',
  'write-workflows',
  'write-ruleset-source',
  'write-credential-policy',
  'git-commit',
  'git-remote-bind',
  'git-push',
  'github-read',
  'github-write',
  'github-repository-create',
  'github-workflow-dispatch',
  'github-secret-write',
  'registry-publish',
  'backend-state-read',
  'backend-state-write',
  'azure-read',
  'azure-provider-register',
  'azure-network-provision',
  'azure-state-import',
  'azure-resource-provision',
  'github-ruleset-write'
]         ;

                                                           

export const approvalGateKinds = [
  'none',
  'repository-publish',
  'activation-plan',
  'credential-enrollment',
  'infrastructure-cost',
  'enforcement',
  'destructive-disposal',
  'external-blocker'
]         ;

                                                                

export const humanAuthorityQuestionKinds = [
  'repository-creation-initial-commit-push',
  'credential-enrollment',
  'billed-infrastructure-policy-exception-cost-ceiling',
  'final-enforcement',
  'destructive-operation',
  'external-blocker'
]         ;

                                                                                    

export const invalidationInputKinds = [
  'activation-identity',
  'graph-hash',
  'baseline-sha',
  'project-files',
  'policy',
  'approval-envelope',
  'credentials',
  'provider-inventory',
  'runner-inventory',
  'remote-state',
  'workflow-source',
  'live-readback',
  'security-evidence',
  'ruleset-readback'
]         ;

                                                                          

export const rollbackKinds = ['none', 'retain', 'reverse-to', 'dispose']         ;
                                                        

                                     
                         
                                  
                        
                                    
                                  
                         
                                       
                                      
                                        
                                    
                                        
 

                                       
                         
                        
                                    
                                  
 

                                  
                            
                                         
                      
 

                                
                      
     
                          
                                                                                                                                        
                   
                               
                                        
      

                               
                         
                    
                                
 

                                   
                                  
                                   
 

                                                      

                                      
                 
                    
                              
                                                         
 

                                   
                     
                         
                      
 

                                 
              
                
                                           
                                    
                                     
                                
                             
                                                       
                             
                                                
 

                                    
                        
                                 
                                    
                     
                              
                                   
                                   
                                  
    
 

                                          
                   
                
                 
                           
                                      
                     
    
           
                           
                     
                   
    
                               
                                                                      
 

                                                 
                   
                    
                 
 

                                         
                                 
                   
                      
                     
                    
                     
                                             
                   
                      
 

                                    
                               
                            
                           
 

                                         
                       
                      
                                      
         
                                                                                        
                                                                                       
    
 

                                                
                   
                                            
                   
                                        
                                   
                                       
                       
                     
     
                          
                                                                
  

                                                 
                   
                                   
                   
                     
                         
                                   
                       
                     
                                 
                     
                            
                           
                                                                                 
                              
 

                                      
                                                                     
                       
                                   
                         
                       
      
 

                                    
                   
                     
                       
                                                                                                        
 

                                             
                   
                      
                      
                           
 

                                      
                    
                    
                                         
                               
                              
                                     
                               
 

                                             
                   
                     
                                                                    
                                           
                             
                                                                           
 

                                      
                        
                               
               
               
                 
                          
    
                   
               
                 
                          
                    
                       
    
                 
               
                                  
           
                  
                                                               
                                            
                                            
                                             
                                                
    
                          
                                                
                                                  
                                             
                                                        
                                                               
                                           
                                               
                    
                    
 

                                 
                        
                       
                               
                         
                   
                              
                      
                      
                                         
                     
                   
                     
                               
                          
                                         
                                                                                                        
 

                                    
                        
                       
                               
                         
                   
                      
                      
                                         
                     
                                 
                       
                     
                       
                         
                   
 

                                      
                     
                         
                                              
                    
 

                                 
                    
                            
         
            
                    
                  

                                                 
                                                                                        
                   
                                
                      
                          
               
 

                                      
                               
                   
                               
                   
                                  
                                              
                  
                       
                      
                                 
                                                
                    
                         
      
 

                                    
                               
                   
                               
                   
                                  
                                              
                  
                       
 

                                         
                   
                         
                         
                                           
                              
                                     
 

                                      
                   
                         
                                   
                   
                    
                    
                               
                    
                           
                         
                      
                           
                     
                                    
                                             
             
                               
                      
                                   
                              
                                
    
                                       
                  
                                          
                                                        
                                             
                     
                             
                     
                        
                             
                                               
                                              
      
 

                                          
                                  
                                 
                                     
                     
                       
                                                          
                                                         
                      
                              
                                        
 

                                                  
                   
                             
                           
                            
 

                                            
                        
                        
                      
                                   
                                 
                                                            
                       
                   
 

                                        
               
                   
 

                                           
                                                                                        
                   
                            
                                
 

                                      
                   
                            
                            
 

                                   
                        
             
                   
                             
                               
                      
                     
                                              
                                                    
                                 
                                   
                                      
                                      
                    
                     
                   
                          
                                     
                                       
                                                                
 

                                          
                   
                             
                               
                      
                     
                                              
                                                    
                                 
                                   
                                      
                                      
                          
                                     
                                       
                                                                
 

                                     
                   
                             
                                                  
                            
                                                                                      
                            
                              
                             
                                      
 

                                     
                        
                               
                             
                              
                 
                     
                   
 

export const runnerPreflightDisplayNameTemplate = '<repo>-runner-preflight-read'         ;
export const runnerPreflightSecretName = 'RUNNER_CONFIGURATION_READ_TOKEN'         ;
export const runnerPreflightPatLifetimeDays = 30         ;
export const runnerPreflightRotationLeadDays = 7         ;
export const runnerPreflightRepositoryPermissions = ['metadata:read']         ;
export const runnerPreflightOrganizationPermissions = [
  'hosted-runners:read',
  'network-configurations:read'
]         ;

                                                                   
                                                                                 

                                               
             
                
               
                   
 

                                          
                                
                                  
 

                                                   
               
                          
 

                                              
                         
                  
                                   
                             
                                
          
                                   
                       
                              
    
 

                                                   
                                                      
                               
                                   
 

                                                
                     
                         
                                                     
                    
 

                                   
                        
                               
                                           
                
                               
                                                                 
                      
                                               
                    
                    
                                                           
                        
                                       
                                                                
                      
                           
                                       
                                          
                                               
 
