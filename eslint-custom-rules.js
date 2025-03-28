module.exports = {
  rules: {
    'no-duplicate-method-comment': {
      create: function(context) {
        return {
          Program() {
            const sourceCode = context.getSourceCode();
            const comments = sourceCode.getAllComments();
            
            for (const comment of comments) {
              if (comment.value.includes('duplicate method') || 
                  comment.value.includes('This is a duplicate')) {
                context.report({
                  node: comment,
                  message: 'Potential duplicate method detected based on comment'
                });
              }
            }
          }
        };
      }
    },
    
    'detect-missing-notify-server': {
      create: function(context) {
        return {
          MemberExpression(node) {
            if (node.object && node.object.type === 'ThisExpression' && 
                node.property && node.property.name === '_notifyServer') {
              // Find the method definition that contains this reference
              let currentNode = node;
              while (currentNode && currentNode.type !== 'MethodDefinition') {
                currentNode = currentNode.parent;
              }
              
              if (currentNode) {
                context.report({
                  node: node,
                  message: 'Reference to _notifyServer method which may not be implemented'
                });
              }
            }
          }
        };
      }
    },
    
    'detect-redundant-map-initialization': {
      create: function(context) {
        const mapInitializations = new Map();
        
        return {
          IfStatement(node) {
            // Look for patterns like: if (!this.mapName) { this.mapName = new Map(); }
            if (node.test && node.test.type === 'UnaryExpression' && 
                node.test.operator === '!' && 
                node.test.argument.type === 'MemberExpression' &&
                node.test.argument.object.type === 'ThisExpression') {
              
              const mapName = node.test.argument.property.name;
              
              if (!mapInitializations.has(mapName)) {
                mapInitializations.set(mapName, []);
              }
              
              mapInitializations.get(mapName).push({
                node: node,
                location: context.getSourceCode().getLocFromIndex(node.range[0])
              });
            }
          },
          
          'Program:exit'() {
            for (const [mapName, occurrences] of mapInitializations.entries()) {
              if (occurrences.length > 1) {
                for (const occurrence of occurrences) {
                  context.report({
                    node: occurrence.node,
                    message: `Redundant initialization of map '${mapName}' found in multiple places`
                  });
                }
              }
            }
          }
        };
      }
    },
    
    'detect-conflicting-tone-management': {
      create: function(context) {
        return {
          AssignmentExpression(node) {
            // Look for assignments to currentTone
            if (node.left.type === 'Identifier' && node.left.name === 'currentTone') {
              // Find all assignments to currentTone in the same function
              let functionNode = node;
              while (functionNode && 
                    functionNode.type !== 'FunctionDeclaration' && 
                    functionNode.type !== 'FunctionExpression' &&
                    functionNode.type !== 'ArrowFunctionExpression') {
                functionNode = functionNode.parent;
              }
              
              if (functionNode) {
                context.report({
                  node: node,
                  message: 'Potential conflicting tone management: multiple assignments to currentTone'
                });
              }
            }
          }
        };
      }
    },
    
    'detect-cooldown-mechanism-conflicts': {
      create: function(context) {
        return {
          IfStatement(node) {
            // Look for if statements that check cooldown
            if (node.test && node.test.type === 'CallExpression' && 
                node.test.callee.type === 'MemberExpression' && 
                node.test.callee.property.name === '_isUserInCooldown') {
              
              // Find the method containing this check
              let methodNode = node;
              while (methodNode && methodNode.type !== 'MethodDefinition') {
                methodNode = methodNode.parent;
              }
              
              if (methodNode && methodNode.key && methodNode.key.name === 'processMessage') {
                // This is checking cooldown in processMessage
                context.report({
                  node: node,
                  message: 'Potential cooldown mechanism conflict: Checking cooldown in processMessage before guardian intervention which sets cooldown'
                });
              }
            }
          },
          
          MemberExpression(node) {
            // Look for references to guardianResponse
            if (node.property && node.property.name === 'guardianResponse') {
              // Find if this is in an if statement condition
              let ifNode = node;
              while (ifNode && ifNode.type !== 'IfStatement') {
                ifNode = ifNode.parent;
              }
              
              if (ifNode) {
                context.report({
                  node: node,
                  message: 'Guardian intervention check which may set cooldown after cooldown has already been checked'
                });
              }
            }
          },
          
          // Look for the processMessage method
          MethodDefinition(node) {
            if (node.key && node.key.name === 'processMessage') {
              // Find the structure of the method to check for cooldown check before guardian intervention
              const body = node.value.body;
              
              if (body && body.body) {
                let foundCooldownCheck = false;
                let foundGuardianCheck = false;
                
                for (const statement of body.body) {
                  // Look for cooldown check
                  if (statement.type === 'IfStatement' && 
                      statement.test.type === 'LogicalExpression' && 
                      statement.test.operator === '&&') {
                    
                    // Check if this is the cooldown check
                    if (statement.test.right && 
                        statement.test.right.type === 'CallExpression' && 
                        statement.test.right.callee.type === 'MemberExpression' && 
                        statement.test.right.callee.property.name === '_isUserInCooldown') {
                      foundCooldownCheck = true;
                    }
                  }
                  
                  // Look for guardian intervention check after cooldown check
                  if (foundCooldownCheck && 
                      statement.type === 'VariableDeclaration' && 
                      statement.declarations[0] && 
                      statement.declarations[0].id.name === 'guardianResponse') {
                    foundGuardianCheck = true;
                    
                    context.report({
                      node: statement,
                      message: 'Cooldown check occurs before guardian intervention check in processMessage, but guardian intervention sets cooldown'
                    });
                  }
                }
              }
            }
          }
        };
      }
    },
    
    'detect-conversation-starter-conflicts': {
      create: function(context) {
        return {
          MethodDefinition(node) {
            if (node.key && node.key.name === 'getConversationStarters') {
              // Look for complex conditional logic that might conflict
              let complexConditions = 0;
              
              // Count the number of if statements in this method
              const ifStatements = context.getSourceCode().getTokens(node).filter(token => 
                token.type === 'Keyword' && token.value === 'if'
              );
              
              if (ifStatements.length > 3) {
                context.report({
                  node: node,
                  message: 'Complex conditional logic in getConversationStarters may lead to conflicting behavior'
                });
              }
            }
          }
        };
      }
    }
  }
};
