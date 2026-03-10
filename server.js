const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');

// ── Cargar .env (local) — en Render las vars vienen del entorno ──
require('dotenv').config();
console.log('🚀 Servidor iniciando...');


const MONGO_URI  = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'secretkey123';
const PORT       = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// ── Uploads ─────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|jpg|jpeg|png|gif|xlsx|xls|doc|docx)$/i.test(file.originalname);
    cb(null, ok);
  },
});

// ── MongoDB ──────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ MongoDB:', err.message));

// ══════════════════════════════════════════════════════════════════
//  MODELOS
// ══════════════════════════════════════════════════════════════════

const UserSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true },
  role:      { type: String, enum: ['profesor','alumno','padre'], default: 'alumno' },
  children:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now },
});
const User = mongoose.model('User', UserSchema);

const CourseSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  code:        { type: String, unique: true },
  teacher:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  students:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  grades:      { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
  createdAt:   { type: Date, default: Date.now },
});
const Course = mongoose.model('Course', CourseSchema);

const TaskSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  description: { type: String, default: '' },
  dueDate:     { type: String, default: '' },
  course:      { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  teacher:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  attachments: [{ name: String, url: String, size: Number }],
  // Rúbrica para evaluación con IA
  rubric: {
    criteria: [{ name: String, description: String, maxPoints: Number }],
    totalPoints: { type: Number, default: 100 },
    instructions: { type: String, default: '' },
  },
  createdAt:   { type: Date, default: Date.now },
});
const Task = mongoose.model('Task', TaskSchema);

const SubmissionSchema = new mongoose.Schema({
  task:        { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
  student:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  course:      { type: mongoose.Schema.Types.ObjectId, ref: 'Course' },
  files:       [{ name: String, url: String, size: Number }],
  comment:     { type: String, default: '' },
  submittedAt: { type: Date, default: Date.now },
  // Campos de evaluación IA
  aiScore:      { type: Number, default: null },
  aiFeedback:   { type: String, default: '' },
  aiBreakdown:  [{ criterion: String, score: Number, maxPoints: Number, comment: String }],
  aiStatus:     { type: String, enum: ['pending','graded','accepted','adjusted'], default: 'pending' },
  finalScore:   { type: Number, default: null },   // calificación final (aceptada o ajustada)
  gradedAt:     { type: Date, default: null },
});
const Submission = mongoose.model('Submission', SubmissionSchema);

// ── Auth middleware ──────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.header('x-auth-token');
  if (!token) return res.status(401).json({ msg: 'Sin token' });
  try { req.user = jwt.verify(token, JWT_SECRET).user; next(); }
  catch { res.status(401).json({ msg: 'Token inválido' }); }
}

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// ══════════════════════════════════════════════════════════════════
//  PING
// ══════════════════════════════════════════════════════════════════
app.get('/api/ping', (req, res) =>
  res.json({ ok: true, mongo: mongoose.connection.readyState === 1 }));

// ══════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  const { name, email: rawEmail, password, role } = req.body;
  const email = rawEmail?.trim().toLowerCase();
  try {
    if (await User.findOne({ email }))
      return res.status(400).json({ msg: 'El correo ya está registrado' });
    const hash = await bcrypt.hash(password, 10);
    const user = await new User({ name, email, password: hash, role }).save();
    const token = jwt.sign({ user: { id: user.id, role: user.role } }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, role: user.role, name: user.name, userId: user.id });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email: rawEmail, password } = req.body;
  const email = rawEmail?.trim().toLowerCase();
  try {
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(400).json({ msg: 'Credenciales inválidas' });
    const token = jwt.sign({ user: { id: user.id, role: user.role } }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, role: user.role, name: user.name, userId: user.id });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  CURSOS
// ══════════════════════════════════════════════════════════════════
app.post('/api/courses', auth, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ msg: 'Nombre requerido' });
    let code, exists = true;
    while (exists) { code = genCode(); exists = await Course.findOne({ code }); }
    const course = await new Course({ name, description: description || '', code, teacher: req.user.id }).save();
    res.json({ msg: 'Curso creado', course });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Cursos del MAESTRO
app.get('/api/courses', auth, async (req, res) => {
  try {
    const courses = await Course.find({ teacher: req.user.id })
      .populate('students', 'name email').sort({ createdAt: -1 });
    res.json(courses);
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Cursos del ALUMNO
app.get('/api/courses/mine', auth, async (req, res) => {
  try {
    const courses = await Course.find({ students: req.user.id })
      .populate('teacher', 'name email').sort({ createdAt: -1 });
    res.json(courses);
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.get('/api/courses/all', auth, async (req, res) => {
  try {
    const courses = await Course.find()
      .populate('teacher', 'name email').populate('students', 'name email').sort({ createdAt: -1 });
    res.json(courses);
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Unirse con código
app.post('/api/courses/join', auth, async (req, res) => {
  try {
    const course = await Course.findOne({ code: (req.body.code || '').toUpperCase() });
    if (!course) return res.status(404).json({ msg: 'Código inválido' });
    if (course.students.map(s => s.toString()).includes(req.user.id))
      return res.status(400).json({ msg: 'Ya estás inscrito' });
    course.students.push(req.user.id);
    await course.save();
    res.json({ msg: 'Inscrito exitosamente', courseName: course.name });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Detalle de curso
app.get('/api/courses/:id', auth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate('teacher', 'name email').populate('students', 'name email');
    if (!course) return res.status(404).json({ msg: 'Curso no encontrado' });
    const studentsWithGrades = course.students.map(s => {
      const g = (course.grades && course.grades.get) ? (course.grades.get(s._id.toString()) || {}) : {};
      return { _id: s._id, name: s.name, email: s.email,
        grade: g.grade ?? 0, attendance: g.attendance ?? 0,
        tasksDelivered: g.tasksDelivered ?? 0, totalTasks: g.totalTasks ?? 0 };
    });
    res.json({ ...course.toObject(), students: studentsWithGrades });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.delete('/api/courses/:id', auth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ msg: 'No encontrado' });
    if (course.teacher.toString() !== req.user.id)
      return res.status(403).json({ msg: 'No autorizado' });
    await Course.findByIdAndDelete(req.params.id);
    res.json({ msg: 'Eliminado' });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Calificación de alumno
app.put('/api/courses/:courseId/students/:studentId/grade', auth, async (req, res) => {
  try {
    const { grade, attendance, tasksDelivered, totalTasks } = req.body;
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ msg: 'Curso no encontrado' });
    const existing = (course.grades && course.grades.get) ? (course.grades.get(req.params.studentId) || {}) : {};
    course.grades.set(req.params.studentId, {
      ...existing,
      ...(grade          !== undefined && { grade }),
      ...(attendance     !== undefined && { attendance }),
      ...(tasksDelivered !== undefined && { tasksDelivered }),
      ...(totalTasks     !== undefined && { totalTasks }),
    });
    course.markModified('grades');
    await course.save();
    res.json({ msg: 'Calificación actualizada' });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Mi calificación en un curso (alumno)
app.get('/api/courses/:courseId/mygrade', auth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId).populate('teacher', 'name');
    if (!course) return res.status(404).json({ msg: 'Curso no encontrado' });
    const g = (course.grades && course.grades.get) ? (course.grades.get(req.user.id) || {}) : {};
    res.json({
      courseId: course._id, courseName: course.name,
      teacher: course.teacher?.name || '',
      grade: g.grade ?? null, attendance: g.attendance ?? 0,
      tasksDelivered: g.tasksDelivered ?? 0, totalTasks: g.totalTasks ?? 0,
    });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  TAREAS  —  POST /api/tasks   y   GET /api/tasks/course/:courseId
// ══════════════════════════════════════════════════════════════════

// Crear tarea (profesor) con archivos adjuntos y rúbrica opcional
app.post('/api/tasks', auth, upload.array('files', 10), async (req, res) => {
  try {
    const { title, description, dueDate, courseId, rubric } = req.body;
    if (!title || !courseId) return res.status(400).json({ msg: 'Título y curso requeridos' });

    const attachments = (req.files || []).map(f => ({
      name: f.originalname, url: `/uploads/${f.filename}`, size: f.size,
    }));

    // Parsear rúbrica si viene como string JSON
    let parsedRubric = null;
    if (rubric) {
      try { parsedRubric = typeof rubric === 'string' ? JSON.parse(rubric) : rubric; }
      catch (_) {}
    }

    const task = await new Task({
      title, description, dueDate,
      course: courseId, teacher: req.user.id, attachments,
      ...(parsedRubric && { rubric: parsedRubric }),
    }).save();

    // Incrementar totalTasks en grades de cada alumno
    const course = await Course.findById(courseId);
    if (course) {
      for (const sId of course.students) {
        const g = (course.grades && course.grades.get) ? (course.grades.get(sId.toString()) || {}) : {};
        course.grades.set(sId.toString(), { ...g, totalTasks: (g.totalTasks || 0) + 1 });
      }
      course.markModified('grades');
      await course.save();
    }
    res.json({ msg: 'Tarea creada', task });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Listar tareas de un curso  ←  ruta que usa el cliente Flutter
app.get('/api/tasks/course/:courseId', auth, async (req, res) => {
  try {
    const tasks = await Task.find({ course: req.params.courseId }).sort({ createdAt: -1 });
    // Marcar si el alumno ya entregó cada tarea
    const withStatus = await Promise.all(tasks.map(async t => {
      const sub = await Submission.findOne({ task: t._id, student: req.user.id });
      return { ...t.toObject(), submitted: !!sub };
    }));
    res.json(withStatus);
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Entregar tarea (alumno sube archivos)
app.post('/api/tasks/:taskId/submit', auth, upload.array('files', 10), async (req, res) => {
  try {
    const already = await Submission.findOne({ task: req.params.taskId, student: req.user.id });
    if (already) return res.status(400).json({ msg: 'Ya entregaste esta tarea' });

    const { comment, courseId } = req.body;
    const files = (req.files || []).map(f => ({
      name: f.originalname, url: `/uploads/${f.filename}`, size: f.size,
    }));

    await new Submission({
      task: req.params.taskId, student: req.user.id,
      course: courseId, files, comment,
    }).save();

    // Actualizar tasksDelivered
    if (courseId) {
      const course = await Course.findById(courseId);
      if (course) {
        const g = (course.grades && course.grades.get) ? (course.grades.get(req.user.id) || {}) : {};
        course.grades.set(req.user.id, { ...g, tasksDelivered: (g.tasksDelivered || 0) + 1 });
        course.markModified('grades');
        await course.save();
      }
    }
    res.json({ msg: 'Tarea entregada exitosamente' });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  BÚSQUEDA DE ALUMNOS
// ══════════════════════════════════════════════════════════════════
app.get('/api/students/search', auth, async (req, res) => {
  try {
    const q = (req.query.name || '').trim();
    if (q.length < 2) return res.json([]);
    const users = await User.find({ role: 'alumno', name: { $regex: q, $options: 'i' } })
      .select('name email _id').limit(10);
    res.json(users);
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  PADRES
// ══════════════════════════════════════════════════════════════════
app.get('/api/parent/children', auth, async (req, res) => {
  try {
    const parent = await User.findById(req.user.id).populate('children', 'name email');
    res.json(parent?.children || []);
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.post('/api/parent/link-child', auth, async (req, res) => {
  try {
    const { childId } = req.body;
    const parent = await User.findById(req.user.id);
    if (!parent) return res.status(404).json({ msg: 'Usuario no encontrado' });
    if (parent.children.map(c => c.toString()).includes(childId))
      return res.status(400).json({ msg: 'Ya vinculado' });
    parent.children.push(childId);
    await parent.save();
    res.json({ msg: 'Hijo vinculado' });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.get('/api/parent/child/:childId/summary', auth, async (req, res) => {
  try {
    const child = await User.findById(req.params.childId).select('name email');
    if (!child) return res.status(404).json({ msg: 'Alumno no encontrado' });
    const courses = await Course.find({ students: req.params.childId }).populate('teacher', 'name');
    const summary = await Promise.all(courses.map(async c => {
      const g    = (c.grades && c.grades.get) ? (c.grades.get(req.params.childId) || {}) : {};
      const tasks = await Task.find({ course: c._id });
      const subs  = await Submission.find({ course: c._id, student: req.params.childId });
      return {
        courseId: c._id, courseName: c.name, teacher: c.teacher?.name || '',
        grade: g.grade ?? null, attendance: g.attendance ?? 0,
        tasksDelivered: subs.length, totalTasks: tasks.length,
      };
    }));
    res.json({ child: { _id: child._id, name: child.name, email: child.email }, courses: summary });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
//  MODELO ASISTENCIA
// ══════════════════════════════════════════════════════════════════
const AttendanceSchema = new mongoose.Schema({
  course:    { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  student:   { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
  date:      { type: String, required: true },   // "YYYY-MM-DD"
  qrToken:   { type: String, default: '' },       // token usado para registrar
  method:    { type: String, enum: ['qr', 'manual'], default: 'qr' },
  createdAt: { type: Date, default: Date.now },
});
// Un alumno solo puede registrarse UNA vez por día por curso
AttendanceSchema.index({ course: 1, student: 1, date: 1 }, { unique: true });
const Attendance = mongoose.model('Attendance', AttendanceSchema);

// ── Token QR activo por curso (en memoria — se regenera cada 45 min) ──
// { courseId: { token, expiresAt } }
const activeQRTokens = {};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ══════════════════════════════════════════════════════════════════
//  ASISTENCIA — ENDPOINTS
// ══════════════════════════════════════════════════════════════════

// Maestro genera/renueva el token QR de un curso
app.post('/api/attendance/qr/generate', auth, async (req, res) => {
  try {
    const { courseId } = req.body;
    if (!courseId) return res.status(400).json({ msg: 'courseId requerido' });

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const token = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const expiresAt = Date.now() + 45 * 60 * 1000; // 45 min

    activeQRTokens[courseId] = { token, expiresAt };

    res.json({ token, expiresAt, date: todayStr() });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Obtener token QR activo (para mostrar en pantalla del maestro)
app.get('/api/attendance/qr/:courseId', auth, async (req, res) => {
  try {
    const entry = activeQRTokens[req.params.courseId];
    if (!entry || Date.now() > entry.expiresAt) {
      // limpiar si expiró
      delete activeQRTokens[req.params.courseId];
      return res.status(404).json({ msg: 'No hay QR activo para este curso' });
    }
    const remainingMs = entry.expiresAt - Date.now();
    const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));
    res.json({ token: entry.token, expiresAt: entry.expiresAt, remainingSeconds, date: todayStr() });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Desactivar QR manualmente (maestro lo apaga)
app.delete('/api/attendance/qr/:courseId', auth, async (req, res) => {
  try {
    delete activeQRTokens[req.params.courseId];
    res.json({ msg: 'QR desactivado' });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// ── Página web pública para que el alumno aterrice al escanear el QR ──
// URL: GET /attend?token=XXXXXX&course=courseId
app.get('/attend', async (req, res) => {
  const { token, course } = req.query;
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Registrar Asistencia</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f1f4f8; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 20px; padding: 32px 24px;
            max-width: 400px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.12); text-align: center; }
    .icon { font-size: 56px; margin-bottom: 12px; }
    h1 { font-size: 22px; font-weight: 700; color: #1a1a2e; margin-bottom: 6px; }
    p  { color: #666; font-size: 14px; margin-bottom: 24px; }
    input { width: 100%; padding: 14px; border: 2px solid #e0e0e0; border-radius: 12px;
            font-size: 16px; outline: none; text-align: center; letter-spacing: 2px;
            font-weight: 700; margin-bottom: 16px; }
    input:focus { border-color: #6200ea; }
    button { width: 100%; padding: 15px; background: #6200ea; color: white; border: none;
             border-radius: 12px; font-size: 16px; font-weight: 700; cursor: pointer; }
    button:disabled { background: #ccc; cursor: not-allowed; }
    .msg { margin-top: 16px; padding: 12px; border-radius: 10px; font-size: 14px; font-weight: 600; }
    .ok  { background: #e8f5e9; color: #2e7d32; }
    .err { background: #ffebee; color: #c62828; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📋</div>
    <h1>Registrar Asistencia</h1>
    <p>Ingresa tu correo para confirmar tu asistencia de hoy</p>
    <input id="email" type="email" placeholder="tu@correo.com" autocomplete="email">
    <input id="token" type="text" placeholder="Código QR (6-8 caracteres)"
           value="${token || ''}" maxlength="8" style="text-transform:uppercase">
    <button id="btn" onclick="register()">✅ Registrar mi asistencia</button>
    <div id="msg"></div>
  </div>
  <script>
    const courseId = '${course || ''}';
    async function register() {
      const email = document.getElementById('email').value.trim();
      const tok   = document.getElementById('token').value.trim().toUpperCase();
      const btn   = document.getElementById('btn');
      const msg   = document.getElementById('msg');
      if (!email || !tok) { showMsg('Completa todos los campos', false); return; }
      btn.disabled = true; btn.textContent = 'Registrando...';
      try {
        const r = await fetch('/api/attendance/register-web', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, token: tok, courseId })
        });
        const d = await r.json();
        if (r.ok) { showMsg('¡Asistencia registrada! ✅ ' + d.studentName, true); btn.textContent = '¡Listo!'; }
        else      { showMsg(d.msg || 'Error al registrar', false); btn.disabled = false; btn.textContent = 'Registrar'; }
      } catch(e) { showMsg('Error de conexión', false); btn.disabled = false; btn.textContent = 'Registrar'; }
    }
    function showMsg(t, ok) {
      const m = document.getElementById('msg');
      m.className = 'msg ' + (ok ? 'ok' : 'err');
      m.textContent = t;
    }
    // Pre-fill token from URL
    document.getElementById('token').value = '${token || ''}'.toUpperCase();
  </script>
</body>
</html>`);
});

// Registro desde la página web pública (sin JWT — solo email + token)
app.post('/api/attendance/register-web', async (req, res) => {
  try {
    const { email, token, courseId } = req.body;
    if (!email || !token || !courseId)
      return res.status(400).json({ msg: 'Email, token y courseId son requeridos' });

    // Validar token QR activo
    const entry = activeQRTokens[courseId];
    if (!entry || Date.now() > entry.expiresAt || entry.token !== token.toUpperCase())
      return res.status(400).json({ msg: 'Código QR inválido o expirado. Pide uno nuevo a tu maestro.' });

    // Buscar alumno por email
    const student = await User.findOne({ email: { $regex: new RegExp(`^${email.trim()}$`, 'i') }, role: 'alumno' });
    if (!student)
      return res.status(404).json({ msg: 'No se encontró un alumno con ese correo. ¿Estás registrado?' });

    // Verificar que el alumno esté inscrito en el curso
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ msg: 'Curso no encontrado' });
    if (!course.students.map(s => s.toString()).includes(student._id.toString()))
      return res.status(403).json({ msg: 'No estás inscrito en este curso' });

    const date = todayStr();
    try {
      await new Attendance({ course: courseId, student: student._id, date, qrToken: token, method: 'qr' }).save();
    } catch (dupErr) {
      if (dupErr.code === 11000)
        return res.status(400).json({ msg: '¡Ya registraste tu asistencia hoy! ✅' });
      throw dupErr;
    }

    res.json({ msg: 'Asistencia registrada', studentName: student.name });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Registro desde la app Flutter (alumno autenticado escribe el código)
app.post('/api/attendance/register', auth, async (req, res) => {
  try {
    const { token, courseId } = req.body;
    if (!token || !courseId)
      return res.status(400).json({ msg: 'token y courseId requeridos' });

    const entry = activeQRTokens[courseId];
    if (!entry || Date.now() > entry.expiresAt || entry.token !== token.toUpperCase())
      return res.status(400).json({ msg: 'Código QR inválido o expirado' });

    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ msg: 'Curso no encontrado' });
    if (!course.students.map(s => s.toString()).includes(req.user.id))
      return res.status(403).json({ msg: 'No estás inscrito en este curso' });

    const date = todayStr();
    try {
      await new Attendance({ course: courseId, student: req.user.id, date, qrToken: token, method: 'qr' }).save();
    } catch (dupErr) {
      if (dupErr.code === 11000)
        return res.status(400).json({ msg: '¡Ya registraste tu asistencia hoy!' });
      throw dupErr;
    }

    const studentUser = await User.findById(req.user.id).select('name');
    res.json({ msg: 'Asistencia registrada', studentName: studentUser?.name });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Lista de asistencia del día (maestro)
app.get('/api/attendance/:courseId', auth, async (req, res) => {
  try {
    const date = req.query.date || todayStr();
    const course = await Course.findById(req.params.courseId)
      .populate('students', 'name email');
    if (!course) return res.status(404).json({ msg: 'Curso no encontrado' });

    const records = await Attendance.find({
      course: req.params.courseId, date
    }).populate('student', 'name email');

    const presentIds = new Set(records.map(r => r.student._id.toString()));

    const list = course.students.map(s => ({
      _id:       s._id,
      name:      s.name,
      email:     s.email,
      present:   presentIds.has(s._id.toString()),
      method:    records.find(r => r.student._id.toString() === s._id.toString())?.method || null,
      time:      records.find(r => r.student._id.toString() === s._id.toString())?.createdAt || null,
    }));

    res.json({ date, total: list.length, present: presentIds.size, list });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Registro manual de asistencia (maestro activa/desactiva un alumno)
app.post('/api/attendance/manual', auth, async (req, res) => {
  try {
    const { courseId, studentId, present, date } = req.body;
    const d = date || todayStr();

    if (present) {
      try {
        await new Attendance({
          course: courseId, student: studentId,
          date: d, method: 'manual'
        }).save();
      } catch (dupErr) {
        if (dupErr.code !== 11000) throw dupErr;
        // ya existe — está bien
      }
    } else {
      await Attendance.deleteOne({ course: courseId, student: studentId, date: d });
    }
    res.json({ msg: 'Asistencia actualizada' });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  SOLICITUDES DE ASISTENCIA MANUAL (alumno pide, maestro valida)
// ══════════════════════════════════════════════════════════════════
const AttendanceRequestSchema = new mongoose.Schema({
  course:    { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  student:   { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
  date:      { type: String, required: true },
  reason:    { type: String, default: '' },
  status:    { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
});
AttendanceRequestSchema.index({ course: 1, student: 1, date: 1 }, { unique: true });
const AttendanceRequest = mongoose.model('AttendanceRequest', AttendanceRequestSchema);

// Alumno solicita asistencia manual
app.post('/api/attendance/request', auth, async (req, res) => {
  try {
    const { courseId, reason } = req.body;
    if (!courseId) return res.status(400).json({ msg: 'courseId requerido' });
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ msg: 'Curso no encontrado' });
    if (!course.students.map(s => s.toString()).includes(req.user.id))
      return res.status(403).json({ msg: 'No estás inscrito en este curso' });
    const date = todayStr();
    try {
      const req2 = await new AttendanceRequest({
        course: courseId, student: req.user.id, date, reason: reason || ''
      }).save();
      res.json({ msg: 'Solicitud enviada al maestro', requestId: req2._id });
    } catch (dupErr) {
      if (dupErr.code === 11000)
        return res.status(400).json({ msg: 'Ya tienes una solicitud enviada hoy para este curso' });
      throw dupErr;
    }
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Maestro consulta solicitudes pendientes de un curso
app.get('/api/attendance/:courseId/requests', auth, async (req, res) => {
  try {
    const requests = await AttendanceRequest.find({
      course: req.params.courseId, status: 'pending'
    }).populate('student', 'name email').sort({ createdAt: -1 });
    res.json(requests);
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Maestro aprueba o rechaza una solicitud
app.post('/api/attendance/request/:id/approve', auth, async (req, res) => {
  try {
    const { approve } = req.body; // true = aprobar, false = rechazar
    const request = await AttendanceRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ msg: 'Solicitud no encontrada' });
    request.status = approve ? 'approved' : 'rejected';
    await request.save();
    if (approve) {
      // Registrar asistencia en el modelo Attendance
      try {
        await new Attendance({
          course: request.course, student: request.student,
          date: request.date, method: 'manual'
        }).save();
      } catch (dupErr) {
        if (dupErr.code !== 11000) throw dupErr;
      }
    }
    res.json({ msg: approve ? 'Asistencia aprobada' : 'Solicitud rechazada' });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Exportar Excel de asistencia (descarga directa)
app.get('/api/attendance/:courseId/export', auth, async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const date    = req.query.date || todayStr();
    const course  = await Course.findById(req.params.courseId)
      .populate('students', 'name email');
    if (!course) return res.status(404).json({ msg: 'Curso no encontrado' });

    const records  = await Attendance.find({ course: req.params.courseId, date })
      .populate('student', 'name email');
    const presentIds = new Set(records.map(r => r.student._id.toString()));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Asistencia');

    // Estilo encabezado
    ws.mergeCells('A1:E1');
    ws.getCell('A1').value = `Lista de Asistencia — ${course.name}`;
    ws.getCell('A1').font  = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    ws.getCell('A1').fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6200EA' } };
    ws.getCell('A1').alignment = { horizontal: 'center' };

    ws.mergeCells('A2:E2');
    ws.getCell('A2').value = `Fecha: ${date}  |  Presentes: ${presentIds.size} / ${course.students.length}`;
    ws.getCell('A2').font  = { italic: true, color: { argb: 'FF555555' } };
    ws.getCell('A2').alignment = { horizontal: 'center' };

    ws.addRow([]);
    const header = ws.addRow(['#', 'Nombre', 'Correo', 'Asistencia', 'Método']);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3700B3' } };
      cell.alignment = { horizontal: 'center' };
    });
    ws.columns = [
      { key: 'num',       width: 6  },
      { key: 'name',      width: 28 },
      { key: 'email',     width: 30 },
      { key: 'present',   width: 14 },
      { key: 'method',    width: 12 },
    ];

    course.students.forEach((s, i) => {
      const present = presentIds.has(s._id.toString());
      const rec     = records.find(r => r.student._id.toString() === s._id.toString());
      const row     = ws.addRow({
        num:     i + 1,
        name:    s.name,
        email:   s.email,
        present: present ? '✅ Presente' : '❌ Ausente',
        method:  rec ? (rec.method === 'qr' ? 'QR' : 'Manual') : '—',
      });
      row.getCell('present').font = { color: { argb: present ? 'FF2E7D32' : 'FFC62828' }, bold: true };
      if (i % 2 === 0) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E5FF' } };
        });
      }
    });

    // Fila resumen al final
    ws.addRow([]);
    const summary = ws.addRow(['', '', 'TOTAL PRESENTES:', `${presentIds.size}`, '']);
    summary.getCell('C').font = { bold: true };
    summary.getCell('D').font = { bold: true, color: { argb: 'FF2E7D32' } };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="asistencia_${course.name}_${date}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  EVALUACIÓN CON IA — GEMINI
// ══════════════════════════════════════════════════════════════════
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

// Calificar una entrega con Gemini
app.post('/api/ai/grade/:submissionId', auth, async (req, res) => {
  try {
    if (!GEMINI_KEY)
      return res.status(503).json({ msg: 'GEMINI_API_KEY no configurada en .env' });

    const submission = await Submission.findById(req.params.submissionId)
      .populate('student', 'name email')
      .populate({ path: 'task', populate: { path: 'course', select: 'name' } });

    if (!submission) return res.status(404).json({ msg: 'Entrega no encontrada' });

    const task = submission.task;
    const rubric = task.rubric;

    // ── Construir prompt ──────────────────────────────────────────
    const criteriaText = rubric?.criteria?.length
      ? rubric.criteria.map((c, i) =>
          `${i+1}. ${c.name} (${c.maxPoints} pts): ${c.description}`).join('\n')
      : 'Criterio único: Calidad general del trabajo (100 pts)';

    const totalPoints = rubric?.totalPoints || 100;

    let submissionContent = submission.comment || '(Sin comentario del alumno)';
    if (submission.files?.length) {
      submissionContent += `\n\nArchivos entregados: ${submission.files.map(f => f.name).join(', ')}`;
    }

    const prompt = `Eres un asistente evaluador académico. Evalúa la siguiente entrega de un alumno basándote ESTRICTAMENTE en la rúbrica proporcionada.

MATERIA/CURSO: ${task.course?.name || 'N/A'}
TAREA: ${task.title}
DESCRIPCIÓN DE LA TAREA: ${task.description || 'Sin descripción'}

RÚBRICA DE EVALUACIÓN (Total: ${totalPoints} puntos):
${criteriaText}

ENTREGA DEL ALUMNO (${submission.student?.name}):
${submissionContent}

INSTRUCCIONES ADICIONALES DEL MAESTRO: ${rubric?.instructions || 'Ninguna'}

Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta (sin markdown, sin texto adicional):
{
  "totalScore": <número entre 0 y ${totalPoints}>,
  "percentage": <número entre 0 y 100>,
  "breakdown": [
    { "criterion": "<nombre del criterio>", "score": <puntos obtenidos>, "maxPoints": <puntos máximos>, "comment": "<retroalimentación específica>" }
  ],
  "generalFeedback": "<retroalimentación general constructiva en español, 2-3 oraciones>",
  "strengths": "<puntos fuertes del trabajo>",
  "improvements": "<áreas de mejora concretas>"
}`;

    // ── Llamar a Gemini API ───────────────────────────────────────
    const parts = [{ text: prompt }];

    // Si hay imágenes en los archivos, intentar incluirlas
    // (para archivos en servidor local, incluimos el nombre como referencia)

    const geminiBody = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.3,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      ],
    };

    const fetch = require('node-fetch');
    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini error:', errText);
      return res.status(502).json({ msg: 'Error al llamar a Gemini', detail: errText });
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Parsear JSON de la respuesta
    let parsed;
    try {
      const clean = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error('Error parsing Gemini response:', rawText);
      return res.status(502).json({ msg: 'Gemini devolvió respuesta no válida', raw: rawText });
    }

    // Guardar en la BD
    submission.aiScore      = parsed.totalScore;
    submission.aiFeedback   = parsed.generalFeedback;
    submission.aiBreakdown  = (parsed.breakdown || []).map(b => ({
      criterion:  b.criterion,
      score:      b.score,
      maxPoints:  b.maxPoints,
      comment:    b.comment,
    }));
    submission.aiStatus     = 'graded';
    await submission.save();

    res.json({
      success:         true,
      submissionId:    submission._id,
      studentName:     submission.student?.name,
      totalScore:      parsed.totalScore,
      totalPoints,
      percentage:      parsed.percentage,
      breakdown:       submission.aiBreakdown,
      generalFeedback: parsed.generalFeedback,
      strengths:       parsed.strengths,
      improvements:    parsed.improvements,
    });
  } catch (e) {
    console.error('AI grade error:', e);
    res.status(500).json({ msg: e.message });
  }
});

// Aceptar o ajustar calificación IA
app.patch('/api/ai/grade/:submissionId/accept', auth, async (req, res) => {
  try {
    const { finalScore, adjusted } = req.body;
    const submission = await Submission.findById(req.params.submissionId);
    if (!submission) return res.status(404).json({ msg: 'No encontrada' });

    submission.finalScore = finalScore ?? submission.aiScore;
    submission.aiStatus   = adjusted ? 'adjusted' : 'accepted';
    submission.gradedAt   = new Date();
    await submission.save();

    // Actualizar también la calificación en el curso
    if (finalScore !== undefined) {
      const normalized = Math.round((finalScore / (submission.task?.rubric?.totalPoints || 100)) * 10);
      await Course.findByIdAndUpdate(submission.course, {
        [`grades.${submission.student}.grade`]: normalized,
      });
    }

    res.json({ success: true, finalScore: submission.finalScore, status: submission.aiStatus });
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Obtener entregas de una tarea con su estado IA (para el maestro)
app.get('/api/tasks/:taskId/submissions', auth, async (req, res) => {
  try {
    const subs = await Submission.find({ task: req.params.taskId })
      .populate('student', 'name email')
      .sort({ submittedAt: -1 });
    res.json(subs);
  } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));