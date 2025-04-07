// Solutions.tsx
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { dracula } from "react-syntax-highlighter/dist/esm/styles/prism"
import dagre from 'dagre'

import {
  Node,
  Edge,
  Position,
  ReactFlow,
  MarkerType,
  } from '@xyflow/react';
  
  import '@xyflow/react/dist/style.css';

import ScreenshotQueue from "../components/Queue/ScreenshotQueue"

import { ProblemStatementData } from "../types/solutions"
import SolutionCommands from "../components/Solutions/SolutionCommands"
import Debug from "./Debug"
import { useToast } from "../contexts/toast"
import { COMMAND_KEY } from "../utils/platform"

const TABS = ['Description', 'Requirements', 'Diagram', 'Database Schema', 'Tradeoff'];

const systemDesignSoltionData = {
  "description": "A VirusTotal-like system is a multi-engine file and URL analysis platform that scans uploaded content using a wide array of antivirus engines, static and dynamic analyzers, and reputation databases to detect malicious behavior. Users can submit binaries, documents, archives, or URLs and get back aggregated scan results, metadata, and threat intelligence insights.",
  "clarifications": [
    {
      "questions": "Do we need to support both file and URL submissions, or just one to start with?",
      "reason": "Impacts the design of the ingestion and normalization layer and how analyzers are invoked."
    },
    {
      "questions": "Are scan results expected to be real-time or can they be delayed (e.g., async responses)?",
      "reason": "Affects the architecture choice between synchronous APIs vs job queues and polling."
    },
    {
      "questions": "Will we allow public querying of historical scans, and if so, with what retention period?",
      "reason": "Determines storage retention policies and access control mechanisms."
    },
    {
      "questions": "Should we integrate with external AV vendors and sandbox providers, or only use internal engines?",
      "reason": "Changes the scope of orchestration, network access requirements, and pricing model."
    }
  ],
  "functional_requirements": [
    {
      "api_interface": {
        "POST /submit": {
          "request": {
            "headers": { "Authorization": "Bearer <token>" },
            "body": {
              "type": "file | url",
              "value": "base64 string or url",
              "user_id": "string"
            }
          },
          "response": {
            "submission_id": "uuid",
            "status": "queued | completed | error"
          }
        }
      },
      "workflow": "Users upload a file or submit a URL to be analyzed. The system stores it, deduplicates via hash, and enqueues it for multi-engine scanning.",
      "use_case": "Submit content for malware scanning and behavioral analysis."
    },
    {
      "api_interface": {
        "GET /result/:submission_id": {
          "request": { "params": { "submission_id": "uuid" } },
          "response": {
            "submission_id": "uuid",
            "status": "completed | queued | failed",
            "scan_summary": {
              "positives": "number",
              "total_engines": "number"
            },
            "engine_results": {
              "engine_name": {
                "result": "clean | malicious | suspicious",
                "category": "AV | static | dynamic",
                "details": "string"
              }
            }
          }
        }
      },
      "workflow": "Clients poll or query scan results by submission ID, getting both summary and per-engine responses.",
      "use_case": "Retrieve aggregated scan results for a previously submitted file or URL."
    },
    {
      "api_interface": {
        "GET /search?q=:hash": {
          "request": {
            "query": {
              "q": "md5 | sha1 | sha256"
            }
          },
          "response": {
            "found": "boolean",
            "submission_id": "uuid",
            "created_at": "timestamp",
            "scan_summary": "object"
          }
        }
      },
      "workflow": "Checks if the system has already scanned the content before based on the hash.",
      "use_case": "De-duplicate submissions and return cached results to reduce compute."
    }
  ],
  "non_functional_requirements": {
    "traffic": "10K submissions/day, 100K API reads/day, spikes during malware campaigns or coordinated threat scans.",
    "storage": "Files up to 100MB each, with 1-year retention. Estimated 10TB/year raw files, 1TB metadata.",
    "latency": "File upload to scan result within 15 seconds (P95). Result fetch latency < 300ms.",
    "optimization_in_quality": "Optimize for accuracy and scan breadth (number of engines) with reasonable latency. Tradeoff: asynchronous model to support slower engines and sandboxing."
  },
  "component_dive_deep": [
    {
      "alternative": "S3 for cold storage vs EFS or MinIO",
      "reason": "S3 is cost-effective and scalable for storing binaries and results.",
      "tradeoff": "Higher latency for read-access vs faster but costlier EFS.",
      "component": "File Storage"
    },
    {
      "alternative": "Redis vs PostgreSQL for job tracking",
      "reason": "Redis supports fast polling and pub/sub for async job status.",
      "tradeoff": "Redis is in-memory, so less durable; PostgreSQL is reliable but higher read latency.",
      "component": "Scan Job Queue Status Store"
    },
    {
      "alternative": "Event-driven processing (Kafka + workers) vs direct API-triggered fan-out",
      "reason": "Kafka enables reliable fan-out to multiple AV engines and retries.",
      "tradeoff": "Adds operational complexity vs simpler sync model with worse scalability.",
      "component": "Scan Orchestrator"
    }
  ],
  "open_questions": "Should scan results be publicly viewable or strictly private per user? This affects privacy guarantees, result caching, and query exposure model.",
  "nodes": [
    { "id": "1", "data": { "label": "API Gateway" }, "position": { "x": 0, "y": 0 } },
    { "id": "2", "data": { "label": "Upload Service" }, "position": { "x": 200, "y": 0 } },
    { "id": "3", "data": { "label": "File Storage (S3)" }, "position": { "x": 400, "y": -100 } },
    { "id": "4", "data": { "label": "Submission Metadata DB" }, "position": { "x": 400, "y": 100 } },
    { "id": "5", "data": { "label": "Scan Orchestrator" }, "position": { "x": 600, "y": 0 } },
    { "id": "6", "data": { "label": "Engine A (AV)" }, "position": { "x": 800, "y": -150 } },
    { "id": "7", "data": { "label": "Engine B (Static)" }, "position": { "x": 800, "y": 0 } },
    { "id": "8", "data": { "label": "Engine C (Sandbox)" }, "position": { "x": 800, "y": 150 } },
    { "id": "9", "data": { "label": "Result Aggregator" }, "position": { "x": 1000, "y": 0 } },
    { "id": "10", "data": { "label": "Scan Result DB" }, "position": { "x": 1200, "y": 0 } },
    { "id": "11", "data": { "label": "Search & Query API" }, "position": { "x": 1400, "y": 0 } }
  ],
  "edges": [
    { "id": "e1-2", "source": "1", "target": "2", "label": "Submit file or URL" },
    { "id": "e2-3", "source": "2", "target": "3", "label": "Store binary" },
    { "id": "e2-4", "source": "2", "target": "4", "label": "Save metadata" },
    { "id": "e4-5", "source": "4", "target": "5", "label": "Queue scan job" },
    { "id": "e5-6", "source": "5", "target": "6", "label": "Dispatch to AV engine" },
    { "id": "e5-7", "source": "5", "target": "7", "label": "Dispatch to static engine" },
    { "id": "e5-8", "source": "5", "target": "8", "label": "Dispatch to sandbox engine" },
    { "id": "e6-9", "source": "6", "target": "9", "label": "Return scan result" },
    { "id": "e7-9", "source": "7", "target": "9", "label": "Return scan result" },
    { "id": "e8-9", "source": "8", "target": "9", "label": "Return scan result" },
    { "id": "e9-10", "source": "9", "target": "10", "label": "Persist aggregated result" },
    { "id": "e10-11", "source": "10", "target": "11", "label": "Serve query" }
  ],
  "steps_walkthrough": [
    "1 → 2: User submits file or URL through the API Gateway to the Upload Service.",
    "2 → 3: The file is stored in a cold storage like S3.",
    "2 → 4: Submission metadata (hash, timestamp, user, type) is stored.",
    "4 → 5: The orchestrator is notified to start the scan pipeline.",
    "5 → 6/7/8: Orchestrator dispatches scanning jobs to various engines.",
    "6/7/8 → 9: Each engine completes the scan and returns its result to the aggregator.",
    "9 → 10: Aggregated scan result is persisted in the result database.",
    "10 → 11: Users or analysts can query results via the public search API."
  ],
  "database_schema": [
    {
      "table": "submissions",
      "columns": {
        "id": "uuid - unique identifier for each submission",
        "user_id": "string - ID of the user who submitted",
        "type": "string - file or url",
        "original_value": "string - base64 file reference or raw URL",
        "hash": "string - sha256 of the file or normalized URL",
        "status": "string - queued, scanning, completed",
        "created_at": "timestamp - submission time"
      },
      "constraints": [
        "PRIMARY KEY (id)",
        "UNIQUE (hash)",
        "INDEX (user_id)"
      ]
    },
    {
      "table": "scan_results",
      "columns": {
        "id": "uuid - reference to submission",
        "engine_name": "string - name of the engine used",
        "result": "string - clean, malicious, suspicious",
        "category": "string - static, dynamic, AV",
        "details": "text - JSON blob with scan metadata",
        "completed_at": "timestamp - when scan finished"
      },
      "constraints": [
        "PRIMARY KEY (id, engine_name)",
        "INDEX (engine_name, result)"
      ]
    }
  ]
}


interface Clarification {
  questions: string;
  reason: string;
}

type FunctionalRequirement = {
  use_case: string;
  workflow: string;
  api_interface: Record<string, any>;
};

type NonFunctionalRequirements = {
  traffic: string;
  storage: string;
  latency: string;
  optimization_in_quality: string;
};

const RequirementsSection = ({
  functionalRequirements,
  nonFunctionalRequirements
}: {
  functionalRequirements: FunctionalRequirement[];
  nonFunctionalRequirements: NonFunctionalRequirements;
}) => {
  return (
    <div className="w-full flex text-gray-100 space-x-12 rounded-2xl shadow-xl cursor-default">
      <section className="w-1/2">
        <h2 className="text-2xl font-semibold mb-4 border-b border-gray-700">
          Functional Requirements
        </h2>
        <div className="space-y-6">
          {functionalRequirements.map((req, idx) => (
            <div key={idx} className="bg-gray-900 p-4 rounded-lg shadow-md">
              <h3 className="text-lg font-bold text-white">User Case: {req.use_case}</h3>
              <p className="text-sm text-gray-300 mb-3">Workflow: {req.workflow}</p>
              <pre className="text-sm bg-gray-800 text-gray-200 rounded p-3 overflow-x-auto">
                {JSON.stringify(req.api_interface, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      </section>

      <section className="w-1/2">
        <h2 className="text-2xl font-semibold mb-4 border-b border-gray-700">
          Non-Functional Requirements
        </h2>
        <ul className="space-y-4 text-sm text-gray-200">
          <li>
            <span className="font-semibold text-white">Traffic:</span>{" "}
            {nonFunctionalRequirements.traffic}
          </li>
          <li>
            <span className="font-semibold text-white">Storage:</span>{" "}
            {nonFunctionalRequirements.storage}
          </li>
          <li>
            <span className="font-semibold text-white">Latency:</span>{" "}
            {nonFunctionalRequirements.latency}
          </li>
          <li>
            <span className="font-semibold text-white">Optimization in Quality:</span>{" "}
            {nonFunctionalRequirements.optimization_in_quality}
          </li>
        </ul>
      </section>
    </div>
  );
};

// Type definitions
interface ColumnSchema {
  [columnName: string]: string | undefined;
}

interface TableSchema {
  table: string;
  columns: ColumnSchema;
  constraints: string[];
}

interface DatabaseSchemaProps {
  schema: TableSchema[];
}

const DatabaseSchema: React.FC<DatabaseSchemaProps> = ({ schema }) => {
  return (
    <div className="space-y-6 cursor-defaul">
      {schema.map((table) => (
        <div
          key={table.table}
          className="border border-gray-300 rounded-xl p-4 bg-white shadow-sm"
        >
          <h2 className="text-xl font-semibold text-gray-800 mb-2">
            🗄️ Table: <span className="text-blue-600">{table.table}</span>
          </h2>

          <div className="mb-4">
            <h3 className="text-lg font-medium text-gray-700 mb-1">Columns</h3>
            <ul className="space-y-1 pl-4">
              {Object.entries(table.columns).map(([columnName, type]) => (
                <li key={columnName} className="text-sm text-gray-600">
                  <span className="font-medium text-gray-800">{columnName}</span>: {type}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-medium text-gray-700 mb-1">Constraints</h3>
            <ul className="list-disc pl-6 text-sm text-gray-600">
              {table.constraints.map((constraint, index) => (
                <li key={index}>{constraint}</li>
              ))}
            </ul>
          </div>
        </div>
      ))}
    </div>
  );
};

const StepsWalkthroughSection = ({ steps_walkthrough }: { steps_walkthrough: string[] }) => {
  return (
    <section className="mt-8">
      <h2 className="text-2xl font-semibold mb-4 border-b border-gray-700 pb-2">
        Workflow Walkthrough
      </h2>
      <ol className="space-y-3 list-decimal list-inside text-sm text-gray-300">
        {steps_walkthrough.map((step, idx) => (
          <li key={idx} className="leading-relaxed">
            {step}
          </li>
        ))}
      </ol>
    </section>
  );
};
const SystemDesignDescriptionSection = ({
  description,
  clarifications,
}: {
  description: string;
  clarifications: Clarification[];
}) => {
  return (
    <div className="relative p-6 rounded-2xl shadow-lg overflow-hidden">
      <div className="absolute inset-0 bg-gray-900 opacity-20 rounded-2xl z-0"></div>
      <div className="flex w-full space-x-12">
        <div className="w-1/2">
          <h2 className="text-xl font-semibold tracking-wide text-yellow-400">System Overview</h2>
          <p className="text-base leading-relaxed text-gray-100">{description}</p>
        </div>
        <div className="w-1/2"> 
          <h3 className="text-xl font-semibold tracking-wide text-yellow-400">Clarification Questions</h3>
          <ul className="list-disc list-inside space-y-4 text-green-100">
            {clarifications.map((item, index) => (
              <li key={index}>
                <span className="font-medium">{item.questions}</span>
                <div className="text-md text-purple-300 ml-4">{item.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

export const ContentSection = ({
  title,
  content,
  isLoading
}: {
  title: string
  content: React.ReactNode
  isLoading: boolean
}) => (
  <div className="space-y-2">
    <h2 className="text-[13px] font-medium text-white tracking-wide">
      {title}
    </h2>
    {isLoading ? (
      <div className="mt-4 flex">
        <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
          Extracting problem statement...
        </p>
      </div>
    ) : (
      <div className="text-[13px] leading-[1.4] text-gray-100 max-w-[600px]">
        {content}
      </div>
    )}
  </div>
)
const SolutionSection = ({
  title,
  content,
  isLoading,
  currentLanguage
}: {
  title: string
  content: React.ReactNode
  isLoading: boolean
  currentLanguage: string
}) => {
  const [copied, setCopied] = useState(false)

  const copyToClipboard = () => {
    if (typeof content === "string") {
      navigator.clipboard.writeText(content).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
    }
  }

  return (
    <div className="space-y-2 relative">
      <h2 className="text-[13px] font-medium text-white tracking-wide">
        {title}
      </h2>
      {isLoading ? (
        <div className="space-y-1.5">
          <div className="mt-4 flex">
            <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
              Loading solutions...
            </p>
          </div>
        </div>
      ) : (
        <div className="w-full relative">
          <button
            onClick={copyToClipboard}
            className="absolute top-2 right-2 text-xs text-white bg-white/10 hover:bg-white/20 rounded px-2 py-1 transition"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          <SyntaxHighlighter
            showLineNumbers
            language={currentLanguage == "golang" ? "go" : currentLanguage}
            style={dracula}
            customStyle={{
              maxWidth: "100%",
              margin: 0,
              padding: "1rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              backgroundColor: "rgba(22, 27, 34, 0.5)"
            }}
            wrapLongLines={true}
          >
            {content as string}
          </SyntaxHighlighter>
        </div>
      )}
    </div>
  )
}


const nodeWidth = 120;
const nodeHeight = 60;

type LayoutDirection = 'TB' | 'BT' | 'LR' | 'RL';

const getLayoutedElements = (
  nodes: Node[],
  edges: Edge[],
  direction: LayoutDirection = 'TB'
): { nodes: Node[]; edges: Edge[] } => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  const isHorizontal = direction === 'LR' || direction === 'RL';

  dagreGraph.setGraph({
    rankdir: direction,
    nodesep: 80,
    ranksep: 100,
    edgesep: 40,
    marginx: 20,
    marginy: 20,
  });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target, { minlen: 1 });
  });

  dagre.layout(dagreGraph);

  const nodeMap = new Map<string, { x: number; y: number }>();
  const sourceToTargets: Record<string, { targetId: string; x: number }[]> = {};

  const layoutedNodes: Node[] = nodes.map((node) => {
    const { x, y } = dagreGraph.node(node.id);
    nodeMap.set(node.id, { x, y });
    return {
      ...node,
      position: {
        x: x - nodeWidth / 2,
        y: y - nodeHeight / 2,
      },
      sourcePosition: isHorizontal ? Position.Right : Position.Bottom,
      targetPosition: isHorizontal ? Position.Left : Position.Top,
      style: {
        background: '#06b6d4',
        color: '#ffffff',
        border: '2px solid #0891b2',
        borderRadius: 8,
        fontWeight: 'bold',
        padding: 10,
      },
    };
  });

  // Build fanout mapping
  edges.forEach((edge) => {
    const targetX = nodeMap.get(edge.target)?.x ?? 0;
    if (!sourceToTargets[edge.source]) sourceToTargets[edge.source] = [];
    sourceToTargets[edge.source].push({ targetId: edge.target, x: targetX });
  });

  const layoutedEdges: Edge[] = edges.map((edge) => {
    const sourcePos = nodeMap.get(edge.source);
    const targetPos = nodeMap.get(edge.target);
    let transform = 'translate(0px, -16px)';

    if (direction === 'TB' && sourcePos && targetPos) {
      const fanout = sourceToTargets[edge.source];
      if (fanout && fanout.length > 1) {
        const sorted = [...fanout].sort((a, b) => a.x - b.x);
        const index = sorted.findIndex((t) => t.targetId === edge.target);

        // left, middle, right cases
        if (index === 0) {
          transform = 'translate(-100px, -16px)';
        } else if (index === sorted.length - 1) {
          transform = 'translate(100px, -16px)';
        } else {
          transform = 'translate(0px, -20px)';
        }
      } else {
        // fallback for single target
        if (sourcePos.x < targetPos.x) {
          transform = 'translate(-100px, -16px)';
        } else if (sourcePos.x > targetPos.x) {
          transform = 'translate(100px, -16px)';
        }
      }
    }

    return {
      ...edge,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: '#ec4899',
      },
      label: edge.label ?? '',
      style: {
        stroke: '#ec4899',
        strokeWidth: 2,
      },
      labelStyle: {
        fill: '#fef9c3',
        fontWeight: 600,
        transform,
        fontSize: 14,
        maxWidth: 50, // for clarity — not enforced in SVG
        whiteSpace: 'normal',
        wordWrap: 'break-word',
        overflowWrap: 'break-word',
        width: '50px', // SVG foreignObject accepts this        
      },
      labelBgStyle: {
        fillOpacity: 0,
      },
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 4,
    };
  });

  return { nodes: layoutedNodes, edges: layoutedEdges };
}

interface TradeOffItem {
  alternative: string;
  reason: string;
  tradeoff: string;
  component: string;
}

interface TradeOffSessionProps {
  data: TradeOffItem[];
}

const TradeOffSession: React.FC<TradeOffSessionProps> = ({ data }) => {
  return (
    <div className="space-y-6 cursor-defaul">
      {data.map((item, index) => (
        <div
          key={index}
          className="border border-gray-300 rounded-lg p-4 bg-white shadow-md"
        >
          <h2 className="text-lg font-bold text-blue-700">
            🔍 Component: {item.component}
          </h2>
          <div className="mt-2">
            <p className="text-sm text-gray-700">
              <span className="font-semibold text-gray-900">Alternative:</span>{" "}
              {item.alternative}
            </p>
            <p className="text-sm text-gray-700 mt-1">
              <span className="font-semibold text-gray-900">Reason:</span>{" "}
              {item.reason}
            </p>
            <p className="text-sm text-gray-700 mt-1">
              <span className="font-semibold text-gray-900">Tradeoff:</span>{" "}
              {item.tradeoff}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
};


export const ComplexitySection = ({
  timeComplexity,
  spaceComplexity,
  isLoading
}: {
  timeComplexity: string | null
  spaceComplexity: string | null
  isLoading: boolean
}) => {
  // Helper to ensure we have proper complexity values
  const formatComplexity = (complexity: string | null): string => {
    if (!complexity) return "O(n) - Linear time/space complexity";
    
    // Return the complexity as is if it already has Big O notation
    if (complexity.match(/O\([^)]+\)/i)) {
      return complexity;
    }
    
    // Otherwise, add a default Big O
    return `O(n) - ${complexity}`;
  };
  
  const formattedTimeComplexity = formatComplexity(timeComplexity);
  const formattedSpaceComplexity = formatComplexity(spaceComplexity);
  
  return (
    <div className="space-y-2">
      <h2 className="text-[13px] font-medium text-white tracking-wide">
        Complexity
      </h2>
      {isLoading ? (
        <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
          Calculating complexity...
        </p>
      ) : (
        <div className="space-y-3">
          <div className="text-[13px] leading-[1.4] text-gray-100 bg-white/5 rounded-md p-3">
            <div className="flex items-start gap-2">
              <div className="w-1 h-1 rounded-full bg-blue-400/80 mt-2 shrink-0" />
              <div>
                <strong>Time:</strong> {formattedTimeComplexity}
              </div>
            </div>
          </div>
          <div className="text-[13px] leading-[1.4] text-gray-100 bg-white/5 rounded-md p-3">
            <div className="flex items-start gap-2">
              <div className="w-1 h-1 rounded-full bg-blue-400/80 mt-2 shrink-0" />
              <div>
                <strong>Space:</strong> {formattedSpaceComplexity}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export interface SolutionsProps {
  setView: (view: "queue" | "solutions" | "debug") => void
  credits: number
  currentLanguage: string
  setLanguage: (language: string) => void
  currentInterviewMode: string
  setInterviewMode: React.Dispatch<React.SetStateAction<string>>  
}
const Solutions: React.FC<SolutionsProps> = ({
  setView,
  credits,
  currentLanguage,
  setLanguage,
  currentInterviewMode,
  setInterviewMode
}) => {
  const queryClient = useQueryClient()
  const contentRef = useRef<HTMLDivElement>(null)

  const [debugProcessing, setDebugProcessing] = useState(false)
  const [problemStatementData, setProblemStatementData] =
    useState<ProblemStatementData | null>(null)

  const { nodes, edges } = useMemo(() => getLayoutedElements(systemDesignSoltionData.nodes, systemDesignSoltionData.edges), []);
  const [activeSystemDesignSolutionTab, setActiveSystemDesignSolutionTab] = useState('Diagram');

  const [solutionData, setSolutionData] = useState<string | null>(null)
  const [thoughtsData, setThoughtsData] = useState<string[] | null>(null)
  const [timeComplexityData, setTimeComplexityData] = useState<string | null>(
    null
  )
  const [spaceComplexityData, setSpaceComplexityData] = useState<string | null>(
    null
  )

  const [isTooltipVisible, setIsTooltipVisible] = useState(false)
  const [tooltipHeight, setTooltipHeight] = useState(0)

  const [isResetting, setIsResetting] = useState(false)

  interface Screenshot {
    id: string
    path: string
    preview: string
    timestamp: number
  }

  const [extraScreenshots, setExtraScreenshots] = useState<Screenshot[]>([])

  useEffect(() => {
    const fetchScreenshots = async () => {
      try {
        const existing = await window.electronAPI.getScreenshots()
        console.log("Raw screenshot data:", existing)
        const screenshots = (Array.isArray(existing) ? existing : []).map(
          (p) => ({
            id: p.path,
            path: p.path,
            preview: p.preview,
            timestamp: Date.now()
          })
        )
        console.log("Processed screenshots:", screenshots)
        setExtraScreenshots(screenshots)
      } catch (error) {
        console.error("Error loading extra screenshots:", error)
        setExtraScreenshots([])
      }
    }

    fetchScreenshots()
  }, [solutionData])

  const { showToast } = useToast()

  useEffect(() => {
    // Height update logic
    const updateDimensions = () => {
      if (contentRef.current) {
        let contentHeight = contentRef.current.scrollHeight
        const contentWidth = contentRef.current.scrollWidth
        if (isTooltipVisible) {
          contentHeight += tooltipHeight
        }
        window.electronAPI.updateContentDimensions({
          width: currentInterviewMode === "SystemDesign" ? 1400 : contentWidth,
          height: contentHeight
        })
      }
    }

    // Initialize resize observer
    const resizeObserver = new ResizeObserver(updateDimensions)
    if (contentRef.current) {
      resizeObserver.observe(contentRef.current)
    }
    updateDimensions()

    // Set up event listeners
    const cleanupFunctions = [
      window.electronAPI.onScreenshotTaken(async () => {
        try {
          const existing = await window.electronAPI.getScreenshots()
          const screenshots = (Array.isArray(existing) ? existing : []).map(
            (p) => ({
              id: p.path,
              path: p.path,
              preview: p.preview,
              timestamp: Date.now()
            })
          )
          setExtraScreenshots(screenshots)
        } catch (error) {
          console.error("Error loading extra screenshots:", error)
        }
      }),
      window.electronAPI.onResetView(() => {
        // Set resetting state first
        setIsResetting(true)

        // Remove queries
        queryClient.removeQueries({
          queryKey: ["solution"]
        })
        queryClient.removeQueries({
          queryKey: ["new_solution"]
        })

        // Reset screenshots
        setExtraScreenshots([])

        // After a small delay, clear the resetting state
        setTimeout(() => {
          setIsResetting(false)
        }, 0)
      }),
      window.electronAPI.onSolutionStart(() => {
        // Every time processing starts, reset relevant states
        setSolutionData(null)
        setThoughtsData(null)
        setTimeComplexityData(null)
        setSpaceComplexityData(null)
      }),
      window.electronAPI.onProblemExtracted((data) => {
        queryClient.setQueryData(["problem_statement"], data)
      }),
      //if there was an error processing the initial solution
      window.electronAPI.onSolutionError((error: string) => {
        showToast("Processing Failed", error, "error")
        // Reset solutions in the cache (even though this shouldn't ever happen) and complexities to previous states
        const solution = queryClient.getQueryData(["solution"]) as {
          code: string
          thoughts: string[]
          time_complexity: string
          space_complexity: string
        } | null
        if (!solution) {
          setView("queue")
        }
        setSolutionData(solution?.code || null)
        setThoughtsData(solution?.thoughts || null)
        setTimeComplexityData(solution?.time_complexity || null)
        setSpaceComplexityData(solution?.space_complexity || null)
        console.error("Processing error:", error)
      }),
      //when the initial solution is generated, we'll set the solution data to that
      window.electronAPI.onSolutionSuccess((data) => {
        if (!data) {
          console.warn("Received empty or invalid solution data")
          return
        }
        console.log({ data })
        const solutionData = {
          code: data.code,
          thoughts: data.thoughts,
          time_complexity: data.time_complexity,
          space_complexity: data.space_complexity
        }

        queryClient.setQueryData(["solution"], solutionData)
        setSolutionData(solutionData.code || null)
        setThoughtsData(solutionData.thoughts || null)
        setTimeComplexityData(solutionData.time_complexity || null)
        setSpaceComplexityData(solutionData.space_complexity || null)

        // Fetch latest screenshots when solution is successful
        const fetchScreenshots = async () => {
          try {
            const existing = await window.electronAPI.getScreenshots()
            const screenshots =
              existing.previews?.map((p) => ({
                id: p.path,
                path: p.path,
                preview: p.preview,
                timestamp: Date.now()
              })) || []
            setExtraScreenshots(screenshots)
          } catch (error) {
            console.error("Error loading extra screenshots:", error)
            setExtraScreenshots([])
          }
        }
        fetchScreenshots()
      }),

      //########################################################
      //DEBUG EVENTS
      //########################################################
      window.electronAPI.onDebugStart(() => {
        //we'll set the debug processing state to true and use that to render a little loader
        setDebugProcessing(true)
      }),
      //the first time debugging works, we'll set the view to debug and populate the cache with the data
      window.electronAPI.onDebugSuccess((data) => {
        queryClient.setQueryData(["new_solution"], data)
        setDebugProcessing(false)
      }),
      //when there was an error in the initial debugging, we'll show a toast and stop the little generating pulsing thing.
      window.electronAPI.onDebugError(() => {
        showToast(
          "Processing Failed",
          "There was an error debugging your code.",
          "error"
        )
        setDebugProcessing(false)
      }),
      window.electronAPI.onProcessingNoScreenshots(() => {
        showToast(
          "No Screenshots",
          "There are no extra screenshots to process.",
          "neutral"
        )
      }),
      // Removed out of credits handler - unlimited credits in this version
    ]

    return () => {
      resizeObserver.disconnect()
      cleanupFunctions.forEach((cleanup) => cleanup())
    }
  }, [isTooltipVisible, tooltipHeight, currentInterviewMode])

  useEffect(() => {
    setProblemStatementData(
      queryClient.getQueryData(["problem_statement"]) || null
    )
    setSolutionData(queryClient.getQueryData(["solution"]) || null)

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event?.query.queryKey[0] === "problem_statement") {
        setProblemStatementData(
          queryClient.getQueryData(["problem_statement"]) || null
        )
      }
      if (event?.query.queryKey[0] === "solution") {
        const solution = queryClient.getQueryData(["solution"]) as {
          code: string
          thoughts: string[]
          time_complexity: string
          space_complexity: string
        } | null

        setSolutionData(solution?.code ?? null)
        setThoughtsData(solution?.thoughts ?? null)
        setTimeComplexityData(solution?.time_complexity ?? null)
        setSpaceComplexityData(solution?.space_complexity ?? null)
      }
    })
    return () => unsubscribe()
  }, [queryClient])

  const handleTooltipVisibilityChange = (visible: boolean, height: number) => {
    setIsTooltipVisible(visible)
    setTooltipHeight(height)
  }

  const handleDeleteExtraScreenshot = async (index: number) => {
    const screenshotToDelete = extraScreenshots[index]

    try {
      const response = await window.electronAPI.deleteScreenshot(
        screenshotToDelete.path
      )

      if (response.success) {
        // Fetch and update screenshots after successful deletion
        const existing = await window.electronAPI.getScreenshots()
        const screenshots = (Array.isArray(existing) ? existing : []).map(
          (p) => ({
            id: p.path,
            path: p.path,
            preview: p.preview,
            timestamp: Date.now()
          })
        )
        setExtraScreenshots(screenshots)
      } else {
        console.error("Failed to delete extra screenshot:", response.error)
        showToast("Error", "Failed to delete the screenshot", "error")
      }
    } catch (error) {
      console.error("Error deleting extra screenshot:", error)
      showToast("Error", "Failed to delete the screenshot", "error")
    }
  }

  return (
    <>
      {!isResetting && queryClient.getQueryData(["new_solution"]) ? (
        <Debug
          isProcessing={debugProcessing}
          setIsProcessing={setDebugProcessing}
          currentLanguage={currentLanguage}
          setLanguage={setLanguage}
          currentInterviewMode={currentInterviewMode}
          setInterviewMode={setInterviewMode}
        />
      ) : (
        <div ref={contentRef} className="relative">
          <div className="space-y-3 px-4 py-3">
            {/* Conditionally render the screenshot queue if solutionData is available */}
            {solutionData && (
              <div className="bg-transparent w-fit">
                <div className="pb-3">
                  <div className="space-y-3 w-fit">
                    <ScreenshotQueue
                      isLoading={debugProcessing}
                      screenshots={extraScreenshots}
                      onDeleteScreenshot={handleDeleteExtraScreenshot}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Navbar of commands with the SolutionsHelper */}
            <SolutionCommands
              onTooltipVisibilityChange={handleTooltipVisibilityChange}
              isProcessing={!problemStatementData || !solutionData}
              extraScreenshots={extraScreenshots}
              credits={credits}
              currentLanguage={currentLanguage}
              setLanguage={setLanguage}
              currentInterviewMode={currentInterviewMode}
              setInterviewMode={setInterviewMode}
            />

            {/* Main Content - Modified width constraints */}
            <div className="w-full text-sm text-black bg-black/60 rounded-md">
              <div className="rounded-lg overflow-hidden">
                <div className="px-4 py-3 space-y-4 max-w-full">
                  {!solutionData && currentInterviewMode === "Coding" && (
                    <>
                      <ContentSection
                        title="Problem Statement"
                        content={problemStatementData?.problem_statement}
                        isLoading={!problemStatementData}
                      />
                      {problemStatementData && (
                        <div className="mt-4 flex">
                          <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
                            Generating solutions...
                          </p>
                        </div>
                      )}
                    </>
                  )}

                  {solutionData && currentInterviewMode === "Coding" && (
                    <>
                      <ContentSection
                        title={`My Thoughts (${COMMAND_KEY} + Arrow keys to scroll)`}
                        content={
                          thoughtsData && (
                            <div className="space-y-3">
                              <div className="space-y-1">
                                {thoughtsData.map((thought, index) => (
                                  <div
                                    key={index}
                                    className="flex items-start gap-2"
                                  >
                                    <div className="w-1 h-1 rounded-full bg-blue-400/80 mt-2 shrink-0" />
                                    <div>{thought}</div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )
                        }
                        isLoading={!thoughtsData}
                      />

                      <SolutionSection
                        title="Solution"
                        content={solutionData}
                        isLoading={!solutionData}
                        currentLanguage={currentLanguage}
                      />

                      <ComplexitySection
                        timeComplexity={timeComplexityData}
                        spaceComplexity={spaceComplexityData}
                        isLoading={!timeComplexityData || !spaceComplexityData}
                      />
                    </>
                  )}

                  {systemDesignSoltionData && currentInterviewMode === "SystemDesign" && (
                    <div className="flex bg-transparent cursor-default">
                      {TABS.map((tab) => (
                        <button
                          key={tab}
                          onClick={() => setActiveSystemDesignSolutionTab(tab)}
                          className={`px-6 py-3 font-semibold transition duration-150 ease-in-out cursor-default
                            ${
                              activeSystemDesignSolutionTab === tab
                                ? 'border-b-2 border-green-500 text-white opacity-100'
                                : 'text-gray-400'
                            } bg-transparent focus:outline-none`}
                        >
                          {tab}
                        </button>
                      ))}
                    </div>
                  )}

                    {/* Content */}
                    {systemDesignSoltionData && currentInterviewMode === "SystemDesign" && activeSystemDesignSolutionTab === 'Diagram' && (
                      <div className="flex w-full cursor-default">
                        <div className="w-1/2 p-4">
                          <StepsWalkthroughSection steps_walkthrough={systemDesignSoltionData.steps_walkthrough} />
                        </div>
                        <div className="w-1/2 h-[920px] overflow-hidden flex items-center justify-center cursor-default bg-transparent">
                        <ReactFlow
                            nodes={nodes}
                            edges={edges}
                            fitView
                            // nodesDraggable={false}
                            // nodesConnectable={false}
                            // panOnDrag={false}
                            // elementsSelectable={false}                  
                          >
                        </ReactFlow>
                      </div>
                      </div>
                    )}
                    {systemDesignSoltionData && currentInterviewMode === "SystemDesign" && activeSystemDesignSolutionTab === 'Description' && (
                      <SystemDesignDescriptionSection
                        description={systemDesignSoltionData.description || ""}
                        clarifications={systemDesignSoltionData.clarifications || []}
                      />                            
                    )}
                    {systemDesignSoltionData && currentInterviewMode === "SystemDesign" && activeSystemDesignSolutionTab === 'Requirements' && (
                      <RequirementsSection
                        functionalRequirements={systemDesignSoltionData.functional_requirements || []}
                        nonFunctionalRequirements={systemDesignSoltionData.non_functional_requirements || {}}
                      />                            
                    )}
                    {systemDesignSoltionData && currentInterviewMode === "SystemDesign" && activeSystemDesignSolutionTab === 'Database Schema' && (
                      <DatabaseSchema schema={systemDesignSoltionData.database_schema || []}/>                            
                    )}     
                    {systemDesignSoltionData && currentInterviewMode === "SystemDesign" && activeSystemDesignSolutionTab === 'Tradeoff' && (
                      <TradeOffSession data={systemDesignSoltionData.component_dive_deep} />
                    )}
                </div>                
              </div>
            </div>
          </div>
        </div>
    )}
  </>
)
}

export default Solutions
