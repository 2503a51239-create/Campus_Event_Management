require('dotenv').config();
const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.JWT_SECRET || 'development-only-change-this-secret';
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'CampusConnect';
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 250, standardHeaders: true, legacyHeaders: false }));

let db = { users: [], events: [], registrations: [], notifications: [], assignments: [], feedback: [] };
let mongoClient;
let stateCollection;
const save = () => stateCollection ? stateCollection.replaceOne({ _id: 'main' }, { _id: 'main', ...db }, { upsert: true }).catch(err => console.error('MongoDB save failed:', err.message)) : Promise.resolve();
const id = () => crypto.randomUUID();
const slugify = s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const safeUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, studentId: u.studentId || null });
const tokenFor = u => jwt.sign({ sub: u.id, role: u.role }, SECRET, { expiresIn: '7d' });
function auth(req, res, next) {
  const token = req.cookies.cc_token || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'Please sign in to continue.' });
  try { const p = jwt.verify(token, SECRET); const u = db.users.find(x => x.id === p.sub); if (!u) throw new Error(); req.user = u; next(); }
  catch { res.clearCookie('cc_token'); return res.status(401).json({ error: 'Your session expired. Please sign in again.' }); }
}
const roles = (...allowed) => (req, res, next) => allowed.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have permission to perform this action.' });
const publicEvent = e => ({ id:e.id, title:e.title, slug:e.slug, category:e.category, description:e.description, venue:e.venue, startAt:e.startAt, endAt:e.endAt, capacity:e.capacity, registeredCount:db.registrations.filter(r=>r.eventId===e.id && r.status==='confirmed').length, status:e.status, cover:e.cover || '', organizer:e.organizer || 'CampusConnect', registrationOpen:e.status==='published' && new Date(e.startAt)>new Date() });
function notify(userId, title, message, type='info') { db.notifications.unshift({ id:id(), userId, title, message, type, createdAt:new Date().toISOString(), read:false }); }
const CAMPUS_TZ = process.env.CAMPUS_TIMEZONE || 'Asia/Kolkata';
const dayKey = d => new Intl.DateTimeFormat('en-CA', { timeZone: CAMPUS_TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(d));
const prettyDay = d => new Intl.DateTimeFormat('en-IN', { timeZone: CAMPUS_TZ, day:'numeric', month:'short', year:'numeric' }).format(new Date(d));
function absoluteBase(req) { return (process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, ''); }

async function seed() {
  if (!db.users.some(u=>u.role==='admin')) {
    db.users.push({ id:id(), name:process.env.ADMIN_NAME||'Campus Administrator', email:(process.env.ADMIN_EMAIL||'admin@campusconnect.local').toLowerCase(), password:await bcrypt.hash(process.env.ADMIN_PASSWORD||'ChangeMe123!', 10), role:'admin', createdAt:new Date().toISOString() });
  }
  if (!db.events.length) {
    const now = new Date();
    const samples = [
      ['InnovateX 2026','Technology','A campus innovation showcase featuring student projects, demos and ideas.','Innovation Hub · Block A',2,10,0,120,'published'],
      ['Campus Cultural Fest','Cultural','A celebration of music, dance, art and campus talent.','Open Air Auditorium',7,16,30,500,'published'],
      ['Design Thinking Workshop','Workshop','A hands-on workshop to explore human-centred problem solving.','Seminar Hall 2',10,11,0,80,'published'],
      ['Startup Connect','Entrepreneurship','Meet founders, learn about early-stage ventures and pitch ideas.','Innovation Centre',14,14,0,150,'published'],
      ['Sports Meet','Sports','A day of friendly competition across campus sports.','University Sports Ground',20,8,0,300,'published']
    ];
    samples.forEach(([title,category,description,venue,days,hour,minute,capacity,status],i)=>{const start=new Date(now);start.setDate(start.getDate()+days);start.setHours(hour,minute,0,0);const end=new Date(start);end.setHours(end.getHours()+2);db.events.push({id:id(),title,slug:slugify(title)+'-'+crypto.randomBytes(2).toString('hex'),category,description,venue,startAt:start.toISOString(),endAt:end.toISOString(),capacity,status,organizer:'CampusConnect',createdAt:new Date().toISOString(),createdBy:'system'});});
  }
  await save();
}

app.get('/api/v1/health', (req,res)=>res.json({ok:true,service:'CampusConnect API',version:'2.0.0'}));
app.post('/api/v1/auth/register', async (req,res)=>{
  const {name,email,password,studentId}=req.body||{};
  if(!name||!email||!password||!studentId) return res.status(400).json({error:'Please complete all fields.'});
  if(String(password).length<8) return res.status(400).json({error:'Password must contain at least 8 characters.'});
  const cleanEmail=String(email).trim().toLowerCase();
  if(db.users.some(u=>u.email===cleanEmail)) return res.status(409).json({error:'An account with this email already exists. Please sign in.'});
  if(db.users.some(u=>u.studentId && u.studentId.toLowerCase()===String(studentId).trim().toLowerCase())) return res.status(409).json({error:'This student ID is already registered.'});
  const user={id:id(),name:String(name).trim(),email:cleanEmail,password:await bcrypt.hash(String(password),10),studentId:String(studentId).trim(),role:'student',createdAt:new Date().toISOString()};db.users.push(user);save();
  res.cookie('cc_token',tokenFor(user),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:7*86400000});res.status(201).json({user:safeUser(user)});
});
app.post('/api/v1/auth/login',async(req,res)=>{const {email,password}=req.body||{};const u=db.users.find(x=>x.email===String(email||'').trim().toLowerCase());if(!u||!(await bcrypt.compare(String(password||''),u.password)))return res.status(401).json({error:'Incorrect email or password.'});res.cookie('cc_token',tokenFor(u),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:7*86400000});res.json({user:safeUser(u)});});
app.post('/api/v1/auth/logout',(req,res)=>{res.clearCookie('cc_token');res.json({ok:true});});
app.get('/api/v1/auth/me',auth,(req,res)=>res.json({user:safeUser(req.user)}));

app.get('/api/v1/events',(req,res)=>{const {q,category}=req.query;let events=db.events.filter(e=>e.status==='published');if(q)events=events.filter(e=>(e.title+' '+e.description+' '+e.venue).toLowerCase().includes(String(q).toLowerCase()));if(category&&category!=='All')events=events.filter(e=>e.category===category);events.sort((a,b)=>new Date(a.startAt)-new Date(b.startAt));res.json({events:events.map(publicEvent)});});
app.get('/api/v1/events/:slug',(req,res)=>{const e=db.events.find(x=>x.slug===req.params.slug||x.id===req.params.slug);if(!e||e.status!=='published')return res.status(404).json({error:'This event is not available.'});res.json({event:publicEvent(e)});});
app.post('/api/v1/events/:id/register',auth,roles('student'),(req,res)=>{const e=db.events.find(x=>x.id===req.params.id&&x.status==='published');if(!e)return res.status(404).json({error:'Event not found.'});if(new Date(e.startAt)<=new Date())return res.status(400).json({error:'Registration for this event is closed.'});if(db.registrations.some(r=>r.eventId===e.id&&r.userId===req.user.id&&r.status!=='cancelled'))return res.status(409).json({error:'You are already registered for this event.'});const count=db.registrations.filter(r=>r.eventId===e.id&&r.status==='confirmed').length;if(count>=e.capacity)return res.status(409).json({error:'Sorry, this event is full.'});const r={id:id(),ticketCode:'CC-'+crypto.randomBytes(4).toString('hex').toUpperCase(),eventId:e.id,userId:req.user.id,status:'confirmed',registeredAt:new Date().toISOString(),checkedInAt:null};db.registrations.push(r);notify(req.user.id,'Registration confirmed',`You are registered for ${e.title}. Your ticket is ready.`,'success');save();res.status(201).json({registration:{...r,event:publicEvent(e)}});});
app.get('/api/v1/me/registrations',auth,roles('student'),(req,res)=>{const items=db.registrations.filter(r=>r.userId===req.user.id).map(r=>({...r,event:publicEvent(db.events.find(e=>e.id===r.eventId)||{title:'Event removed'})})).sort((a,b)=>new Date(b.registeredAt)-new Date(a.registeredAt));res.json({registrations:items});});
app.post('/api/v1/registrations/:id/cancel',auth,roles('student'),(req,res)=>{const r=db.registrations.find(x=>x.id===req.params.id&&x.userId===req.user.id);if(!r)return res.status(404).json({error:'Registration not found.'});if(r.checkedInAt)return res.status(400).json({error:'A checked-in ticket cannot be cancelled.'});r.status='cancelled';save();res.json({ok:true});});
app.get('/api/v1/ticket/:code',auth,roles('student'),async(req,res)=>{const r=db.registrations.find(x=>x.ticketCode===req.params.code&&x.userId===req.user.id);if(!r)return res.status(404).json({error:'Ticket not found.'});const e=db.events.find(x=>x.id===r.eventId);res.json({dataUrl:await QRCode.toDataURL(r.ticketCode,{width:320,margin:2})});});
app.get('/api/v1/me/notifications',auth,(req,res)=>res.json({notifications:db.notifications.filter(n=>n.userId===req.user.id).slice(0,30)}));
app.post('/api/v1/me/notifications/read',auth,(req,res)=>{db.notifications.filter(n=>n.userId===req.user.id).forEach(n=>n.read=true);save();res.json({ok:true});});
app.post('/api/v1/events/:id/feedback',auth,roles('student'),(req,res)=>{const {rating,comment}=req.body||{};const registered=db.registrations.some(r=>r.eventId===req.params.id&&r.userId===req.user.id&&r.status==='confirmed');if(!registered)return res.status(403).json({error:'Register for this event before submitting feedback.'});if(![1,2,3,4,5].includes(Number(rating)))return res.status(400).json({error:'Choose a rating from 1 to 5.'});const e=db.events.find(x=>x.id===req.params.id);db.feedback=db.feedback||[];if(db.feedback.some(f=>f.eventId===e.id&&f.userId===req.user.id))return res.status(409).json({error:'You have already submitted feedback.'});db.feedback.push({id:id(),eventId:e.id,userId:req.user.id,rating:Number(rating),comment:String(comment||'').slice(0,1000),createdAt:new Date().toISOString()});save();res.status(201).json({ok:true});});
app.get('/api/v1/events/:id/qr',auth,roles('admin','coordinator'),async(req,res)=>{const e=db.events.find(x=>x.id===req.params.id);if(!e)return res.status(404).json({error:'Event not found.'});if(req.user.role==='coordinator'&&!db.assignments.some(a=>a.eventId===e.id&&a.userId===req.user.id))return res.status(403).json({error:'This event is not assigned to you.'});const url=`${absoluteBase(req)}/event/${e.slug}`;res.json({url,dataUrl:await QRCode.toDataURL(url,{width:480,margin:2,color:{dark:'#17213d',light:'#ffffff'}})});});
app.get('/api/v1/admin/overview',auth,roles('admin','coordinator'),(req,res)=>{let events=db.events;if(req.user.role==='coordinator'){const ids=db.assignments.filter(a=>a.userId===req.user.id).map(a=>a.eventId);events=events.filter(e=>ids.includes(e.id));}const regs=db.registrations.filter(r=>events.some(e=>e.id===r.eventId));res.json({stats:{events:events.length,registrations:regs.filter(r=>r.status==='confirmed').length,checkedIn:regs.filter(r=>r.checkedInAt).length,students:db.users.filter(u=>u.role==='student').length},events:events.map(e=>({...publicEvent(e),assignments:db.assignments.filter(a=>a.eventId===e.id).map(a=>safeUser(db.users.find(u=>u.id===a.userId)||{}))}))});});
app.post('/api/v1/admin/events',auth,roles('admin'),(req,res)=>{const {title,category,description,venue,startAt,endAt,capacity}=req.body||{};if(!title||!category||!venue||!startAt||!endAt||!capacity)return res.status(400).json({error:'Please complete all required event fields.'});if(new Date(endAt)<=new Date(startAt)||new Date(startAt)<=new Date())return res.status(400).json({error:'Choose a valid future start and end time.'});const e={id:id(),title:String(title).trim(),slug:slugify(title)+'-'+crypto.randomBytes(2).toString('hex'),category,description:String(description||''),venue:String(venue).trim(),startAt:new Date(startAt).toISOString(),endAt:new Date(endAt).toISOString(),capacity:Math.max(1,Number(capacity)),status:'published',organizer:req.user.name,createdAt:new Date().toISOString(),createdBy:req.user.id};db.events.push(e);db.users.filter(u=>u.role==='student').forEach(u=>notify(u.id,'New campus event',`${e.title} is now open for registration.`));save();res.status(201).json({event:publicEvent(e)});});
app.patch('/api/v1/admin/events/:id',auth,roles('admin'),(req,res)=>{
  const e=db.events.find(x=>x.id===req.params.id);
  if(!e)return res.status(404).json({error:'Event not found.'});
  if(e.status==='cancelled')return res.status(400).json({error:'A cancelled event cannot be edited.'});
  const b=req.body||{};
  const title=b.title!==undefined?String(b.title).trim():e.title;
  const category=b.category!==undefined?String(b.category).trim():e.category;
  const venue=b.venue!==undefined?String(b.venue).trim():e.venue;
  const description=b.description!==undefined?String(b.description):e.description;
  const startAt=b.startAt!==undefined?new Date(b.startAt):new Date(e.startAt);
  const endAt=b.endAt!==undefined?new Date(b.endAt):new Date(e.endAt);
  const capacity=b.capacity!==undefined?Number(b.capacity):e.capacity;
  if(!title||!category||!venue)return res.status(400).json({error:'Title, category and venue cannot be empty.'});
  if(isNaN(startAt)||isNaN(endAt))return res.status(400).json({error:'Please provide valid start and end times.'});
  if(endAt<=startAt)return res.status(400).json({error:'End time must be after the start time.'});
  const startChanged=startAt.getTime()!==new Date(e.startAt).getTime();
  if(startChanged&&startAt<=new Date())return res.status(400).json({error:'The new start time must be in the future.'});
  if(!Number.isInteger(capacity)||capacity<1)return res.status(400).json({error:'Capacity must be a whole number of at least 1.'});
  const confirmed=db.registrations.filter(r=>r.eventId===e.id&&r.status==='confirmed').length;
  if(capacity<confirmed)return res.status(400).json({error:`Capacity cannot be lower than the ${confirmed} confirmed registration${confirmed===1?'':'s'} already made.`});
  const scheduleChanged=startChanged||endAt.getTime()!==new Date(e.endAt).getTime();
  const venueChanged=venue!==e.venue;
  Object.assign(e,{title,category,venue,description,capacity,startAt:startAt.toISOString(),endAt:endAt.toISOString(),updatedAt:new Date().toISOString(),updatedBy:req.user.id});
  if(scheduleChanged||venueChanged){
    db.registrations.filter(r=>r.eventId===e.id&&r.status==='confirmed').forEach(r=>notify(r.userId,'Event updated',`${e.title} has been updated${scheduleChanged?' (new date/time)':''}${venueChanged?` (new venue: ${e.venue})`:''}. Please check the event details.`,'info'));
  }
  save();res.json({event:publicEvent(e)});
});
app.patch('/api/v1/admin/events/:id/status',auth,roles('admin'),(req,res)=>{const e=db.events.find(x=>x.id===req.params.id);if(!e)return res.status(404).json({error:'Event not found.'});if(!['published','cancelled','draft'].includes(req.body.status))return res.status(400).json({error:'Invalid event status.'});e.status=req.body.status;save();res.json({event:publicEvent(e)});});
app.get('/api/v1/admin/registrations',auth,roles('admin','coordinator'),(req,res)=>{let events=db.events;if(req.user.role==='coordinator'){const ids=db.assignments.filter(a=>a.userId===req.user.id).map(a=>a.eventId);events=events.filter(e=>ids.includes(e.id));}const ids=events.map(e=>e.id);const registrations=db.registrations.filter(r=>ids.includes(r.eventId)).map(r=>({...r,student:safeUser(db.users.find(u=>u.id===r.userId)||{}),event:{id:db.events.find(e=>e.id===r.eventId)?.id,title:db.events.find(e=>e.id===r.eventId)?.title}}));res.json({registrations});});
app.get('/api/v1/admin/staff',auth,roles('admin'),(req,res)=>res.json({staff:db.users.filter(u=>['admin','coordinator'].includes(u.role)).map(safeUser)}));
app.post('/api/v1/admin/staff',auth,roles('admin'),async(req,res)=>{const {name,email,password}=req.body||{};if(!name||!email||!password||String(password).length<8)return res.status(400).json({error:'Provide name, email and a password of at least 8 characters.'});const clean=String(email).trim().toLowerCase();if(db.users.some(u=>u.email===clean))return res.status(409).json({error:'This email is already in use.'});const u={id:id(),name:String(name).trim(),email:clean,password:await bcrypt.hash(String(password),10),role:'coordinator',createdAt:new Date().toISOString()};db.users.push(u);save();res.status(201).json({staff:safeUser(u)});});
app.post('/api/v1/admin/assignments',auth,roles('admin'),(req,res)=>{const {eventId,userId}=req.body||{};const e=db.events.find(x=>x.id===eventId),u=db.users.find(x=>x.id===userId&&x.role==='coordinator');if(!e||!u)return res.status(400).json({error:'Choose a valid event and coordinator.'});if(db.assignments.some(a=>a.eventId===eventId&&a.userId===userId))return res.status(409).json({error:'This coordinator is already assigned.'});db.assignments.push({id:id(),eventId,userId,assignedBy:req.user.id,assignedAt:new Date().toISOString()});notify(userId,'New event assignment',`You have been assigned to coordinate ${e.title}.`,'success');save();res.status(201).json({ok:true});});
app.post('/api/v1/admin/check-in',auth,roles('admin','coordinator'),(req,res)=>{const {ticketCode}=req.body||{};const r=db.registrations.find(x=>x.ticketCode===String(ticketCode||'').trim().toUpperCase()&&x.status==='confirmed');if(!r)return res.status(404).json({error:'No active registration found for this ticket.'});const e=db.events.find(x=>x.id===r.eventId);if(req.user.role==='coordinator'&&!db.assignments.some(a=>a.eventId===r.eventId&&a.userId===req.user.id))return res.status(403).json({error:'This event is not assigned to you.'});if(r.checkedInAt)return res.status(409).json({error:'This ticket has already been checked in.'});if(!e||e.status!=='published')return res.status(400).json({error:'Check-in is not available because this event is not active.'});
const today=dayKey(new Date()),firstDay=dayKey(e.startAt),lastDay=dayKey(e.endAt);
if(today<firstDay)return res.status(400).json({error:`Too early. Check-in for ${e.title} opens only on ${prettyDay(e.startAt)}.`});
if(today>lastDay)return res.status(400).json({error:`Check-in closed. ${e.title} was held on ${prettyDay(e.endAt)}; late check-ins are not allowed.`});r.checkedInAt=new Date().toISOString();notify(r.userId,'Attendance confirmed',`Your attendance at ${e?.title||'the event'} has been recorded.`,'success');save();res.json({ok:true,student:safeUser(db.users.find(u=>u.id===r.userId)),event:e?.title});});
app.get('/api/v1/admin/feedback',auth,roles('admin'),(req,res)=>{res.json({feedback:(db.feedback||[]).map(f=>({...f,student:safeUser(db.users.find(u=>u.id===f.userId)||{}),event:db.events.find(e=>e.id===f.eventId)?.title}))});});
app.get('/student',(req,res)=>res.sendFile(path.join(__dirname,'public','student.html')));
app.get('/student/*',(req,res)=>res.sendFile(path.join(__dirname,'public','student.html')));
app.get('/event/:slug',(req,res)=>res.sendFile(path.join(__dirname,'public','student.html')));
app.get('/admin*',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Something went wrong. Please try again.'});});
async function start() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI is missing. Add your MongoDB connection string to the .env file.');
  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  const mongoDb = mongoClient.db(MONGODB_DB);
  stateCollection = mongoDb.collection('campusconnect_state');
  const existing = await stateCollection.findOne({ _id: 'main' });
  if (existing) {
    db = { users: existing.users || [], events: existing.events || [], registrations: existing.registrations || [], notifications: existing.notifications || [], assignments: existing.assignments || [], feedback: existing.feedback || [] };
  }
  // MongoDB is the sole source of application data. No JSON-file fallback is used.
  await seed();
  app.listen(PORT,'0.0.0.0',()=>console.log(`CampusConnect running at http://localhost:${PORT} (MongoDB connected)`));
}
start().catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
