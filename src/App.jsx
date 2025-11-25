import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Play, Pause, SkipForward, RotateCcw, Save, Terminal, Cpu, Database, Bug, FileText } from 'lucide-react';

/**
 * MIPS ARCHITECTURE CONSTANTS & HELPERS
 */
const REGISTERS = [
  '$zero', '$at', '$v0', '$v1', '$a0', '$a1', '$a2', '$a3',
  '$t0', '$t1', '$t2', '$t3', '$t4', '$t5', '$t6', '$t7',
  '$s0', '$s1', '$s2', '$s3', '$s4', '$s5', '$s6', '$s7',
  '$t8', '$t9', '$k0', '$k1', '$gp', '$sp', '$fp', '$ra'
];

const REG_MAP = REGISTERS.reduce((acc, reg, idx) => ({ ...acc, [reg]: idx }), {});

const MEMORY_SIZE = 1024 * 4; // 4KB simulated memory
const DATA_START = 0x10010000;
const STACK_START = 0x7FFFFFFC;
const TEXT_START = 0x00400000;

const DEFAULT_CODE = `# MIPS Fibonacci Generator
# Calculates the first N Fibonacci numbers

.data
msg_start: .asciiz "Fibonacci Sequence: "
space:     .asciiz ", "
newline:   .asciiz "\\n"

.text
main:
    # Initialize variables
    addi $t0, $zero, 10    # N = 10 (count)
    addi $t1, $zero, 0     # a = 0
    addi $t2, $zero, 1     # b = 1
    
    # Print start message
    li $v0, 4
    la $a0, msg_start
    syscall
    
    # Print first number (0)
    li $v0, 1
    add $a0, $zero, $t1
    syscall
    
    # Print space
    li $v0, 4
    la $a0, space
    syscall

loop:
    # Check if N <= 0
    beq $t0, $zero, exit
    
    # Calculate next: c = a + b
    add $t3, $t1, $t2
    
    # Move: a = b, b = c
    add $t1, $zero, $t2
    add $t2, $zero, $t3
    
    # Print current number (b)
    li $v0, 1
    add $a0, $zero, $t1
    syscall
    
    # Decrement counter
    addi $t0, $t0, -1
    
    # Print separator if not last
    beq $t0, $zero, skip_comma
    li $v0, 4
    la $a0, space
    syscall
    
skip_comma:
    j loop

exit:
    # Print newline
    li $v0, 4
    la $a0, newline
    syscall

    # Exit program
    li $v0, 10
    syscall
`;

/**
 * SIMULATOR CORE
 */
const useMipsSimulator = () => {
  const [regs, setRegs] = useState(new Int32Array(32));
  const [pc, setPc] = useState(TEXT_START);
  const [memory, setMemory] = useState({}); // Sparse memory map: address -> value (byte)
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);
  
  // Assembled program state
  const [instructions, setInstructions] = useState([]);
  const [labelMap, setLabelMap] = useState({});
  const [sourceMap, setSourceMap] = useState([]); // Maps PC to source line number

  // Reset Simulator
  const reset = () => {
    const newRegs = new Int32Array(32);
    newRegs[29] = STACK_START; // $sp
    setRegs(newRegs);
    setPc(TEXT_START);
    setMemory({});
    setOutput("");
    setIsRunning(false);
    setError(null);
  };

  // Memory Access Helpers
  const getMemByte = (addr, currentMem) => currentMem[addr] || 0;
  
  const getMemWord = (addr, currentMem) => {
    return (
      ((currentMem[addr] || 0) << 24) |
      ((currentMem[addr + 1] || 0) << 16) |
      ((currentMem[addr + 2] || 0) << 8) |
      (currentMem[addr + 3] || 0)
    );
  };

  const setMemByte = (addr, val, currentMem) => {
    return { ...currentMem, [addr]: val & 0xFF };
  };

  const setMemWord = (addr, val, currentMem) => {
    const nextMem = { ...currentMem };
    nextMem[addr] = (val >> 24) & 0xFF;
    nextMem[addr + 1] = (val >> 16) & 0xFF;
    nextMem[addr + 2] = (val >> 8) & 0xFF;
    nextMem[addr + 3] = val & 0xFF;
    return nextMem;
  };

  // Assembler
  const assemble = (sourceCode) => {
    // Reset state before assembling but keep the code
    const newRegs = new Int32Array(32);
    newRegs[29] = STACK_START;
    setRegs(newRegs);
    setPc(TEXT_START);
    setOutput("");
    setIsRunning(false);
    setError(null);

    const lines = sourceCode.split('\n');
    const newInstructions = [];
    const newLabelMap = {};
    const newSourceMap = [];
    const newDataSegment = {}; // Temporary holding for parsing .data
    
    let currentSection = '.text';
    let dataPtr = DATA_START;
    let textPtr = TEXT_START;

    try {
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        // Remove comments
        const commentIdx = line.indexOf('#');
        if (commentIdx !== -1) line = line.substring(0, commentIdx).trim();
        
        if (!line) continue;

        // Section directives
        if (line === '.data') { currentSection = '.data'; continue; }
        if (line === '.text') { currentSection = '.text'; continue; }

        // Label detection
        let label = null;
        if (line.includes(':')) {
          const parts = line.split(':');
          label = parts[0].trim();
          line = parts.slice(1).join(':').trim(); // Remainder
          
          if (currentSection === '.text') {
            newLabelMap[label] = textPtr;
          } else {
            newLabelMap[label] = dataPtr;
          }
        }

        if (!line) continue; // Just a label on this line

        if (currentSection === '.data') {
          // Very basic data parser
          const tokens = line.match(/\S+|"[^"]*"/g) || [];
          const directive = tokens[0];
          
          if (directive === '.asciiz' || directive === '.ascii') {
            let str = line.substring(line.indexOf('"') + 1, line.lastIndexOf('"'));
            str = str.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
            for (let j = 0; j < str.length; j++) {
              newDataSegment[dataPtr++] = str.charCodeAt(j);
            }
            if (directive === '.asciiz') newDataSegment[dataPtr++] = 0;
          } else if (directive === '.word') {
            const val = parseInt(tokens[1]);
            newDataSegment[dataPtr] = (val >> 24) & 0xFF;
            newDataSegment[dataPtr+1] = (val >> 16) & 0xFF;
            newDataSegment[dataPtr+2] = (val >> 8) & 0xFF;
            newDataSegment[dataPtr+3] = val & 0xFF;
            dataPtr += 4;
          }
        } else {
          // Text section
           const cleanLine = line.replace(/,/g, ' ');
           const tokens = cleanLine.match(/\S+/g); // Split by whitespace
           
           if (tokens) {
             newInstructions.push({
               pc: textPtr,
               op: tokens[0],
               args: tokens.slice(1),
               original: line,
               sourceLine: i + 1
             });
             newSourceMap[textPtr] = i + 1;
             textPtr += 4;
           }
        }
      }
      
      setInstructions(newInstructions);
      setLabelMap(newLabelMap);
      setMemory(newDataSegment); // Initialize memory with data segment
      setSourceMap(newSourceMap);
      
    } catch (e) {
      setError(`Assembler Error: ${e.message}`);
    }
  };

  // Execution Step
  const step = () => {
    if (error) return;

    // Find instruction
    const currentInst = instructions.find(inst => inst.pc === pc);
    
    if (!currentInst) {
      setIsRunning(false);
      return;
    }

    try {
      const { op, args } = currentInst;
      let nextPc = pc + 4;
      let nextRegs = new Int32Array(regs);
      let nextMem = { ...memory };
      let outputAppend = "";

      // Helper to parse register strings like '$t0' or '0($t1)'
      const parseReg = (str) => {
        if (!str) return 0;
        // Handle offset format 0($t1)
        if (str.includes('(')) {
          const match = str.match(/(-?\d+)\((\$[a-z0-9]+)\)/);
          if (match) return { offset: parseInt(match[1]), reg: REG_MAP[match[2]] };
        }
        return REG_MAP[str];
      };

      const getRegVal = (rIdx) => (rIdx === 0 ? 0 : nextRegs[rIdx]); // $zero is always 0
      
      // Helper to resolve label or immediate
      const getImmOrLabel = (str) => {
        if (labelMap.hasOwnProperty(str)) return labelMap[str];
        return parseInt(str);
      };

      switch (op) {
        case 'add':
        case 'addu': // treat same as add for JS integers
          nextRegs[parseReg(args[0])] = getRegVal(parseReg(args[1])) + getRegVal(parseReg(args[2]));
          break;
        case 'sub':
        case 'subu':
          nextRegs[parseReg(args[0])] = getRegVal(parseReg(args[1])) - getRegVal(parseReg(args[2]));
          break;
        case 'addi':
        case 'addiu':
          nextRegs[parseReg(args[0])] = getRegVal(parseReg(args[1])) + parseInt(args[2]);
          break;
        case 'mul':
          nextRegs[parseReg(args[0])] = Math.imul(getRegVal(parseReg(args[1])), getRegVal(parseReg(args[2])));
          break;
        case 'and':
          nextRegs[parseReg(args[0])] = getRegVal(parseReg(args[1])) & getRegVal(parseReg(args[2]));
          break;
        case 'or':
          nextRegs[parseReg(args[0])] = getRegVal(parseReg(args[1])) | getRegVal(parseReg(args[2]));
          break;
        case 'xor':
          nextRegs[parseReg(args[0])] = getRegVal(parseReg(args[1])) ^ getRegVal(parseReg(args[2]));
          break;
        case 'sll':
          nextRegs[parseReg(args[0])] = getRegVal(parseReg(args[1])) << parseInt(args[2]);
          break;
        case 'srl':
          nextRegs[parseReg(args[0])] = getRegVal(parseReg(args[1])) >>> parseInt(args[2]);
          break;
        case 'slt':
          nextRegs[parseReg(args[0])] = (getRegVal(parseReg(args[1])) < getRegVal(parseReg(args[2]))) ? 1 : 0;
          break;
        case 'slti':
          nextRegs[parseReg(args[0])] = (getRegVal(parseReg(args[1])) < parseInt(args[2])) ? 1 : 0;
          break;
        case 'lui':
           nextRegs[parseReg(args[0])] = (parseInt(args[1]) << 16);
           break;
        case 'li': // Pseudo-instruction support (simple load immediate)
           nextRegs[parseReg(args[0])] = parseInt(args[1]);
           break;
        case 'la': // Pseudo-instruction load address
           nextRegs[parseReg(args[0])] = getImmOrLabel(args[1]);
           break;
        case 'move': // Pseudo
           nextRegs[parseReg(args[0])] = getRegVal(parseReg(args[1]));
           break;
        
        // Memory
        case 'lw': {
           const { offset, reg } = parseReg(args[1]);
           const addr = getRegVal(reg) + offset;
           nextRegs[parseReg(args[0])] = getMemWord(addr, nextMem);
           break;
        }
        case 'sw': {
           const { offset, reg } = parseReg(args[1]);
           const addr = getRegVal(reg) + offset;
           nextMem = setMemWord(addr, getRegVal(parseReg(args[0])), nextMem);
           break;
        }
        case 'lb': {
          const { offset, reg } = parseReg(args[1]);
          const addr = getRegVal(reg) + offset;
          let byte = getMemByte(addr, nextMem);
          // Sign extension for lb
          if (byte & 0x80) byte |= 0xFFFFFF00;
          nextRegs[parseReg(args[0])] = byte;
          break;
        }
        case 'sb': {
           const { offset, reg } = parseReg(args[1]);
           const addr = getRegVal(reg) + offset;
           nextMem = setMemByte(addr, getRegVal(parseReg(args[0])), nextMem);
           break;
        }

        // Control Flow
        case 'beq':
           if (getRegVal(parseReg(args[0])) === getRegVal(parseReg(args[1]))) {
             nextPc = getImmOrLabel(args[2]);
           }
           break;
        case 'bne':
           if (getRegVal(parseReg(args[0])) !== getRegVal(parseReg(args[1]))) {
             nextPc = getImmOrLabel(args[2]);
           }
           break;
        case 'j':
           nextPc = getImmOrLabel(args[0]);
           break;
        case 'jal':
           nextRegs[31] = pc + 4; // $ra
           nextPc = getImmOrLabel(args[0]);
           break;
        case 'jr':
           nextPc = getRegVal(parseReg(args[0]));
           break;

        case 'syscall':
           const v0 = nextRegs[2]; // $v0
           if (v0 === 1) { // print_int
             outputAppend = nextRegs[4].toString(); // $a0
           } else if (v0 === 4) { // print_string
             let addr = nextRegs[4]; // $a0
             let str = "";
             let char = getMemByte(addr, nextMem);
             let loopGuard = 0;
             while (char !== 0 && loopGuard < 1000) {
               str += String.fromCharCode(char);
               addr++;
               char = getMemByte(addr, nextMem);
               loopGuard++;
             }
             outputAppend = str;
           } else if (v0 === 10) { // exit
             setIsRunning(false);
             nextPc = 0; // Terminate
           } else if (v0 === 11) { // print_char
             outputAppend = String.fromCharCode(nextRegs[4]);
           }
           break;

        default:
           // Ignore unknown ops for robustness in this simple sim
           break;
      }

      setRegs(nextRegs);
      setMemory(nextMem);
      setPc(nextPc);
      
      if (outputAppend) {
        setOutput(prev => prev + outputAppend);
      }
      
    } catch (e) {
      setError(`Runtime Error at PC 0x${pc.toString(16)}: ${e.message}`);
      setIsRunning(false);
    }
  };

  // Run Loop
  useEffect(() => {
    if (isRunning) {
      const loop = () => {
        step(); 
      };
      // rapid fire execution
      const timer = setTimeout(loop, 10); 
      return () => clearTimeout(timer);
    }
  }, [isRunning, pc, instructions, regs, memory]); 

  return {
    regs, pc, memory, output, isRunning, error,
    instructions, sourceMap,
    assemble, step, reset, setIsRunning
  };
};

/**
 * UI COMPONENTS
 */

const RegisterView = ({ regs, pc }) => {
  return (
    <div className="grid grid-cols-2 gap-2 text-xs font-mono">
      <div className={`p-1 rounded ${pc === undefined ? 'bg-yellow-100 dark:bg-yellow-900' : 'bg-gray-100 dark:bg-gray-800'}`}>
        <span className="font-bold text-blue-600">PC</span>: <span className="text-gray-700 dark:text-gray-300">0x{pc.toString(16).padStart(8, '0')}</span>
      </div>
      {REGISTERS.map((name, idx) => {
        const val = regs[idx];
        const hex = (val >>> 0).toString(16).padStart(8, '0'); // Unsigned hex shift
        return (
          <div key={name} className="flex justify-between items-center bg-gray-50 dark:bg-gray-800 p-1 rounded border border-gray-200 dark:border-gray-700">
            <span className="font-bold text-purple-600 mr-2">{name}</span>
            <span className="text-gray-600 dark:text-gray-400">{hex}</span>
          </div>
        );
      })}
    </div>
  );
};

const MemoryView = ({ memory }) => {
  // Convert sparse memory to a displayable list of non-zero blocks
  const memKeys = Object.keys(memory).map(Number).sort((a, b) => a - b);
  
  // Group by 16 bytes for display
  if (memKeys.length > 0) {
    // Naive visualization: show regions around active data
    // We'll just show defined bytes
    
    // Find ranges
    const ranges = [];
    let start = memKeys[0];
    let prev = memKeys[0];
    
    for(let i=1; i<memKeys.length; i++) {
        if(memKeys[i] > prev + 16) {
            ranges.push({start, end: prev});
            start = memKeys[i];
        }
        prev = memKeys[i];
    }
    ranges.push({start, end: prev});

    // Render ranges
    return (
        <div className="font-mono text-xs overflow-y-auto h-full space-y-2">
            {ranges.map((range, i) => {
                const rowStart = range.start & 0xFFFFFFF0;
                const rowEnd = (range.end | 0xF) + 1;
                const lines = [];
                for(let addr = rowStart; addr < rowEnd; addr+=16) {
                    const bytes = [];
                    for(let b=0; b<16; b++) {
                       const val = memory[addr+b];
                       bytes.push(val !== undefined ? val.toString(16).padStart(2,'0') : '..');
                    }
                    lines.push(
                        <div key={addr} className="flex space-x-2 border-b border-gray-100 dark:border-gray-800">
                            <span className="text-gray-400 select-none">0x{addr.toString(16).padStart(8,'0')}</span>
                            <span className="text-blue-600">{bytes.slice(0,4).join(' ')}</span>
                            <span className="text-blue-600">{bytes.slice(4,8).join(' ')}</span>
                            <span className="text-blue-600">{bytes.slice(8,12).join(' ')}</span>
                            <span className="text-blue-600">{bytes.slice(12,16).join(' ')}</span>
                        </div>
                    );
                }
                return <div key={i} className="bg-white dark:bg-gray-900 p-2 rounded shadow-sm">{lines}</div>
            })}
            {ranges.length === 0 && <div className="text-gray-400 italic p-4">Memory is empty</div>}
        </div>
    );
  }
  
  return <div className="text-gray-400 italic p-4">Memory is empty</div>;
};

const App = () => {
  const [sourceCode, setSourceCode] = useState(DEFAULT_CODE);
  const sim = useMipsSimulator();
  const [activeTab, setActiveTab] = useState('console'); // 'console' or 'memory'

  // Initial Assembly
  useEffect(() => {
    sim.assemble(DEFAULT_CODE);
  }, []);

  const handleAssemble = () => {
    sim.assemble(sourceCode);
  };

  // Line highlighting
  const currentLine = sim.sourceMap[sim.pc];

  return (
    <div className="flex flex-col h-screen bg-gray-100 dark:bg-gray-950 text-gray-900 dark:text-gray-100 font-sans">
      {/* Header */}
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 p-3 flex items-center justify-between shadow-sm z-10">
        <div className="flex items-center space-x-2">
          <Cpu className="w-6 h-6 text-purple-600" />
          <h1 className="font-bold text-lg tracking-tight">MIPS Studio</h1>
        </div>
        
        <div className="flex items-center space-x-2">
          <button 
            onClick={sim.reset}
            className="p-2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            title="Reset"
          >
            <RotateCcw size={18} />
          </button>
          
          <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 mx-2" />

          <button
            onClick={sim.step}
            disabled={sim.isRunning || !!sim.error}
            className="flex items-center space-x-1 px-3 py-1.5 bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300 rounded font-medium disabled:opacity-50"
          >
            <SkipForward size={16} />
            <span>Step</span>
          </button>

          <button
            onClick={() => sim.setIsRunning(!sim.isRunning)}
            disabled={!!sim.error}
            className={`flex items-center space-x-1 px-4 py-1.5 rounded font-medium text-white transition-all ${
              sim.isRunning 
                ? 'bg-amber-500 hover:bg-amber-600' 
                : 'bg-green-600 hover:bg-green-700'
            } disabled:opacity-50 shadow-sm`}
          >
            {sim.isRunning ? <Pause size={16} /> : <Play size={16} />}
            <span>{sim.isRunning ? 'Pause' : 'Run'}</span>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden flex flex-col lg:flex-row">
        
        {/* Left: Editor */}
        <div className="flex-1 flex flex-col border-r border-gray-200 dark:border-gray-800 min-w-0">
          <div className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 p-2 flex justify-between items-center">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                <FileText size={12}/> Source
            </span>
            <button 
                onClick={handleAssemble}
                className="text-xs bg-purple-100 text-purple-700 hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-300 px-2 py-1 rounded"
            >
                Re-Assemble
            </button>
          </div>
          <div className="flex-1 relative overflow-hidden">
             <textarea
                value={sourceCode}
                onChange={(e) => setSourceCode(e.target.value)}
                className="w-full h-full p-4 font-mono text-sm bg-white dark:bg-gray-950 outline-none resize-none leading-relaxed"
                spellCheck="false"
             />
             {/* Simple Line Highlight Overlay - naive implementation */}
             {currentLine && (
                <div 
                    className="absolute left-0 w-1 bg-yellow-400 pointer-events-none transition-all duration-100"
                    style={{ 
                        top: `${(currentLine - 1) * 1.625 + 1}rem`, // Approximate line height based on p-4 and leading
                        height: '1.5rem' 
                    }}
                />
             )}
          </div>
        </div>

        {/* Middle: Registers */}
        <div className="w-full lg:w-96 border-r border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 flex flex-col">
            <div className="p-2 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                    <Cpu size={12}/> Registers
                </span>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
                <RegisterView regs={sim.regs} pc={sim.pc} />
            </div>
        </div>

        {/* Right: Output & Memory */}
        <div className="flex-1 lg:max-w-md flex flex-col bg-white dark:bg-gray-950">
            <div className="flex border-b border-gray-200 dark:border-gray-800">
                <button
                    onClick={() => setActiveTab('console')}
                    className={`flex-1 py-2 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 ${
                        activeTab === 'console' 
                        ? 'border-purple-500 text-purple-600' 
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                >
                    <Terminal size={14} /> I/O Console
                </button>
                <button
                    onClick={() => setActiveTab('memory')}
                    className={`flex-1 py-2 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 ${
                        activeTab === 'memory' 
                        ? 'border-purple-500 text-purple-600' 
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                >
                    <Database size={14} /> Memory
                </button>
            </div>

            <div className="flex-1 overflow-hidden relative">
                {activeTab === 'console' && (
                    <div className="absolute inset-0 p-4 font-mono text-sm bg-gray-900 text-green-400 overflow-y-auto">
                        <div className="whitespace-pre-wrap font-bold">{sim.output}</div>
                        {!sim.output && <div className="text-gray-600 italic">Program output will appear here...</div>}
                        {sim.error && (
                            <div className="mt-4 p-3 bg-red-900/20 border border-red-900/50 text-red-400 rounded flex items-start gap-2">
                                <Bug size={16} className="mt-1 flex-shrink-0" />
                                <div>{sim.error}</div>
                            </div>
                        )}
                        {sim.instructions.length === 0 && !sim.error && (
                            <div className="mt-2 text-gray-600">
                                No instructions loaded. Click 'Re-Assemble' to load the code.
                            </div>
                        )}
                    </div>
                )}
                
                {activeTab === 'memory' && (
                    <div className="absolute inset-0 bg-gray-50 dark:bg-gray-900 p-2">
                        <MemoryView memory={sim.memory} />
                    </div>
                )}
            </div>
        </div>
      </main>
    </div>
  );
};

export default App;