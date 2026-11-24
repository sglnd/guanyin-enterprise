import test from 'node:test'
import assert from 'node:assert/strict'
import { strongPassword, requiresPasswordChange } from '../public/app-password-policy.js'
test('passwords require eight characters and three actual character categories',()=>{
 for(const value of ['Abcdef12','abcdef1!','ABCDEF1!','Abcdefg!']) assert.equal(strongPassword(value),true,value)
 for(const value of ['Abcd12!','abcdefgh','ABCDEFGH','12345678','Abcdefgh','abc12345','abc     ','中文中文中文中文',null]) assert.equal(strongPassword(value),false,String(value))
})
test('admin is exempt, while flagged users of any other role must change password',()=>{
 assert.equal(requiresPasswordChange({username:'admin',mustChangePassword:true}),false)
 assert.equal(requiresPasswordChange({username:'member',mustChangePassword:true}),true)
 assert.equal(requiresPasswordChange({username:'other-admin',role:'platform_admin',mustChangePassword:true}),true)
 assert.equal(requiresPasswordChange({username:'member',mustChangePassword:false}),false)
})
