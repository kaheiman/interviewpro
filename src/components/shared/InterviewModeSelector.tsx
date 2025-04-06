import React from "react"

interface InterviewModeSelectorProps {
  currentInterviewMode: string
  setInterviewMode: React.Dispatch<React.SetStateAction<string>>  
}

export const InterviewModeSelector: React.FC<InterviewModeSelectorProps> = ({
  currentInterviewMode,
  setInterviewMode
}) => {
  const handleModeChange = async (
    e: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const newInterviewMode = e.target.value
    
    try {
      // Save language preference to electron store
      await window.electronAPI.updateConfig({ interviewMode: newInterviewMode })
      
      // Update global language variable
      window.__INTERVIEW_MODE__  = newInterviewMode
      
      // Update state in React
      setInterviewMode(newInterviewMode)
      
      console.log(`Interview mode changed to ${newInterviewMode}`);
    } catch (error) {
      console.error("Error updating interview mode:", error)
    }
  }

  return (
    <div className="mb-3 px-2 space-y-1">
      <div className="flex items-center justify-between text-[13px] font-medium text-white/90">
        <span>Mode</span>
        <select
          value={currentInterviewMode}
          onChange={handleModeChange}
          className="bg-black/80 text-white/90 rounded px-2 py-1 text-sm outline-none border border-white/10 focus:border-white/20"
          style={{ WebkitAppearance: 'menulist' }}
        >
          <option value="Coding" className="bg-black text-white">Coding</option>
          <option value="SystemDesign" className="bg-black text-white">System Design</option>
        </select>
      </div>
    </div>
  )
}
