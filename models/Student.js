const mongoose = require('mongoose');

const StudentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  grade: { type: String, required: true }, // Ej: "1ro"
  group: { type: String, required: true }, // Ej: "A"
  status: { type: String, default: 'active' }, // active, inactive
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Student', StudentSchema);