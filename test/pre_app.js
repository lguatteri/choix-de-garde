// Stubs pour exécuter app.js sous jsc (pas de DOM, pas de Supabase)
var alert = function(){};
function _el(){ return { style:{}, classList:{add(){},remove(){},toggle(){},contains(){return false;}},
  appendChild(){}, insertBefore(){}, addEventListener(){}, removeEventListener(){}, setAttribute(){},
  removeAttribute(){}, querySelector(){return _el();}, querySelectorAll(){return [];},
  dataset:{}, onclick:null, oninput:null, onchange:null, textContent:'', innerHTML:'', hidden:false,
  value:'', disabled:false, title:'' }; }
var document = {
  readyState:'complete', addEventListener:function(){},
  getElementById:function(){ return _el(); },
  querySelector:function(){ return _el(); },
  querySelectorAll:function(){ return []; },
  createElement:function(){ return _el(); },
  body:{ classList:{ toggle(){}, add(){}, remove(){} } },
  visibilityState:'visible',
};
var window = {};
window.currentUser = { id:'admin-uid' };
window.currentProfile = { doctor_name:null, is_admin:true, is_super_admin:true };
function _chain(){ var p = Promise.resolve({ data:[], error:null });
  var h = { select:()=>h, insert:()=>h, update:()=>h, upsert:()=>h, delete:()=>h, eq:()=>h, gte:()=>h,
    order:()=>h, maybeSingle:()=>p, then:(f,g)=>p.then(f,g) }; return h; }
window.supabaseClient = { from:_chain, channel:()=>({ on(){return this;}, subscribe(){return this;} }), removeChannel:()=>{} };
