const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Course = require('../models/Course');
const User = require('../models/User');

// ── Generar código único de 6 dígitos ──────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ── POST /api/courses  → Crear curso (solo profesor/admin) ──
router.post('/', auth, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ msg: 'El nombre es obligatorio' });

    // Generar código único
    let code;
    let exists = true;
    while (exists) {
      code = generateCode();
      exists = await Course.findOne({ code });
    }

    const course = new Course({
      name,
      description: description || '',
      code,
      teacher: req.user.id,
      students: []
    });

    await course.save();
    res.json({ success: true, course });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
});

// ── GET /api/courses  → Listar cursos del profesor ──
router.get('/', auth, async (req, res) => {
  try {
    const courses = await Course.find({ teacher: req.user.id })
      .populate('students', 'name email')
      .sort({ createdAt: -1 });
    res.json(courses);
  } catch (err) {
    res.status(500).json({ msg: 'Error del servidor' });
  }
});

// ── GET /api/courses/all  → Todos los cursos (admin) ──
router.get('/all', auth, async (req, res) => {
  try {
    const courses = await Course.find()
      .populate('teacher', 'name email')
      .populate('students', 'name email')
      .sort({ createdAt: -1 });
    res.json(courses);
  } catch (err) {
    res.status(500).json({ msg: 'Error del servidor' });
  }
});

// ── GET /api/courses/mine  → Cursos donde el alumno está inscrito ──
router.get('/mine', auth, async (req, res) => {
  try {
    const courses = await Course.find({ students: req.user.id })
      .populate('teacher', 'name')
      .sort({ createdAt: -1 });
    res.json(courses);
  } catch (err) {
    res.status(500).json({ msg: 'Error del servidor' });
  }
});

// ── POST /api/courses/join  → Alumno se une por código ──
router.post('/join', auth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ msg: 'Código requerido' });

    const course = await Course.findOne({ code: code.toUpperCase() });
    if (!course) return res.status(404).json({ msg: 'Código incorrecto o no existe' });

    // Verificar que no esté ya inscrito
    if (course.students.includes(req.user.id)) {
      return res.status(400).json({ msg: 'Ya estás inscrito en este curso' });
    }

    course.students.push(req.user.id);
    await course.save();

    res.json({ success: true, courseName: course.name });
  } catch (err) {
    res.status(500).json({ msg: 'Error del servidor' });
  }
});

// ── GET /api/courses/:id  → Detalle de un curso ──
router.get('/:id', auth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate('teacher', 'name email')
      .populate('students', 'name email');
    if (!course) return res.status(404).json({ msg: 'Curso no encontrado' });
    res.json(course);
  } catch (err) {
    res.status(500).json({ msg: 'Error del servidor' });
  }
});

// ── DELETE /api/courses/:id  → Borrar curso ──
router.delete('/:id', auth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ msg: 'Curso no encontrado' });
    if (course.teacher.toString() !== req.user.id)
      return res.status(403).json({ msg: 'No autorizado' });
    await course.deleteOne();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ msg: 'Error del servidor' });
  }
});

module.exports = router;