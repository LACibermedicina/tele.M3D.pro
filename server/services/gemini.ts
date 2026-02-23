import { GoogleGenerativeAI } from "@google/generative-ai";
import { db } from "../db";
import { chatbotReferences } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";

// Lazy initialization to prevent crashes when API key is missing
let genAI: GoogleGenerativeAI | null = null;

function getGeminiClient(): GoogleGenerativeAI {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is not configured. Please add it to your deployment configuration.');
  }
  
  if (!genAI) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  
  return genAI;
}

export interface DiagnosticHypothesis {
  condition: string;
  probability: number;
  reasoning: string;
  ministryGuidelines?: string;
}

export interface SchedulingRequest {
  patientMessage: string;
  patientName?: string;
  requestedDate?: string;
  requestedTime?: string;
  urgency: 'low' | 'medium' | 'high';
}

export interface SchedulingResponse {
  isSchedulingRequest: boolean;
  suggestedAppointment?: {
    date: string;
    time: string;
    type: string;
  };
  response: string;
  requiresHumanIntervention: boolean;
}

async function generateWithJSON(prompt: string): Promise<any> {
  const client = getGeminiClient();
  const model = client.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json"
    }
  });
  
  const result = await model.generateContent(prompt);
  const response = result.response.text();
  return JSON.parse(response);
}

async function generateText(prompt: string, systemInstruction?: string): Promise<string> {
  const client = getGeminiClient();
  const model = client.getGenerativeModel({ 
    model: "gemini-2.5-flash"
  });
  
  // Include system instruction in the prompt if provided
  const fullPrompt = systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt;
  
  const result = await model.generateContent(fullPrompt);
  return result.response.text();
}

export class GeminiService {
  async analyzeWhatsappMessage(message: string, patientHistory?: string): Promise<{
    isSchedulingRequest: boolean;
    isClinicalQuestion: boolean;
    response: string;
    suggestedAction?: string;
  }> {
    try {
      const prompt = `
        Você é uma IA assistente médica integrada ao WhatsApp. Analise a mensagem do paciente e determine:
        
        1. Se é uma solicitação de agendamento
        2. Se é uma pergunta clínica
        3. Forneça uma resposta apropriada baseada nas diretrizes do Ministério da Saúde
        
        Mensagem do paciente: "${message}"
        ${patientHistory ? `Histórico do paciente: ${patientHistory}` : ''}
        
        Responda em JSON com os campos: isSchedulingRequest, isClinicalQuestion, response, suggestedAction
      `;

      return await generateWithJSON(prompt);
    } catch (error) {
      console.error('Gemini analysis error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Failed to analyze WhatsApp message'
      });
      return {
        isSchedulingRequest: false,
        isClinicalQuestion: false,
        response: error instanceof Error && error.message.includes('GEMINI_API_KEY')
          ? 'Funcionalidade de IA temporariamente indisponível. Por favor, entre em contato diretamente com nosso suporte.'
          : 'Desculpe, houve um erro ao processar sua mensagem. Por favor, tente novamente.',
      };
    }
  }

  async processSchedulingRequest(
    message: string, 
    availableDoctors?: Array<{ 
      doctorId: string; 
      doctorName: string; 
      availableSlots: Array<{ dateIso: string; time: string; label: string }> 
    }>
  ): Promise<SchedulingResponse> {
    try {
      let availabilityInfo = '';
      let slotsMetadata: Record<string, { dateIso: string; time: string }> = {};
      
      if (availableDoctors && availableDoctors.length > 0) {
        availabilityInfo = 'Médicos disponíveis com horários estruturados:\n';
        availableDoctors.forEach(doctor => {
          availabilityInfo += `\n- Dr(a). ${doctor.doctorName} (ID: ${doctor.doctorId})\n`;
          availabilityInfo += '  Horários disponíveis:\n';
          doctor.availableSlots.forEach(slot => {
            const slotKey = `${doctor.doctorId}_${slot.dateIso}_${slot.time}`;
            slotsMetadata[slotKey] = { dateIso: slot.dateIso, time: slot.time };
            availabilityInfo += `    - ${slot.label} [dateIso: ${slot.dateIso}, time: ${slot.time}]\n`;
          });
        });
      } else {
        availabilityInfo = 'Nenhum médico disponível no momento. Solicite que o paciente escolha outra data.';
      }

      const prompt = `
        Você é um assistente de agendamento médico inteligente. Analise a solicitação de agendamento do paciente e sugira o melhor médico e horário disponível baseado na DISPONIBILIDADE REAL dos médicos.
        
        Mensagem do paciente: "${message}"
        
        ${availabilityInfo}
        
        IMPORTANTE: 
        - Você DEVE sugerir apenas horários que estão REALMENTE disponíveis na lista acima
        - Se não houver horários disponíveis, informe o paciente e peça para escolher outra data
        - Sempre inclua o ID do médico na resposta
        - COPIE EXATAMENTE o dateIso e time do horário escolhido - não invente valores
        - O campo dateIso já está no formato YYYY-MM-DD correto
        - O campo time já está no formato HH:MM correto
        
        Forneça uma resposta em JSON com:
        - isSchedulingRequest: boolean (sempre true se for uma solicitação de agendamento)
        - suggestedAppointment: { dateIso: string (copie o valor exato do horário escolhido), time: string (copie o valor exato do horário escolhido), doctorId: string, doctorName: string, type: string }
        - response: string (resposta amigável para o paciente explicando a sugestão, use o label do horário para melhor comunicação)
        - requiresHumanIntervention: boolean (true se não houver disponibilidade)
      `;

      const result = await generateWithJSON(prompt);
      return {
        ...result,
        isSchedulingRequest: true
      };
    } catch (error) {
      console.error('Gemini scheduling error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Failed to process scheduling request'
      });
      return {
        isSchedulingRequest: true,
        response: 'Desculpe, não foi possível processar sua solicitação de agendamento no momento. Por favor, tente novamente ou entre em contato com nossa equipe.',
        requiresHumanIntervention: true,
      };
    }
  }

  async generateDiagnosticHypotheses(symptoms: string, patientHistory: string): Promise<DiagnosticHypothesis[]> {
    try {
      const prompt = `
        Como um assistente médico especializado, analise os sintomas e histórico do paciente para gerar hipóteses diagnósticas baseadas nas diretrizes do Ministério da Saúde brasileiro.
        
        Sintomas: "${symptoms}"
        Histórico do paciente: "${patientHistory}"
        
        Forneça até 5 hipóteses diagnósticas mais prováveis em JSON com:
        - hypotheses: array de objetos, cada um com:
          - condition: nome da condição
          - probability: probabilidade em porcentagem (0-100)
          - reasoning: justificativa clínica
          - ministryGuidelines: referência às diretrizes do MS quando aplicável
        
        Responda com um objeto JSON contendo o campo "hypotheses".
      `;

      const result = await generateWithJSON(prompt);
      return result.hypotheses || [];
    } catch (error) {
      console.error('Gemini diagnostic error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Failed to generate diagnostic hypotheses'
      });
      throw error;
    }
  }

  async analyzeSymptomsForMedicalRecord(symptoms: string, patientHistory: string): Promise<{
    diagnosis: string;
    treatment: string;
    prescription: string;
    hypotheses: DiagnosticHypothesis[];
    recommendations: string;
  }> {
    try {
      const prompt = `
        Como um assistente médico especializado em medicina brasileira, analise os sintomas e histórico do paciente para auxiliar o médico na redação do prontuário médico.
        
        Sintomas apresentados: "${symptoms}"
        Histórico do paciente: "${patientHistory}"
        
        IMPORTANTE: Esta é uma análise de suporte. O médico é responsável pela decisão final.
        
        Forneça uma análise completa em JSON com:
        
        1. diagnosis: Diagnóstico sugerido (hipótese diagnóstica principal com justificativa clínica detalhada)
        
        2. treatment: Plano de tratamento sugerido (incluindo medidas não-farmacológicas, orientações gerais, e quando necessário retorno)
        
        3. prescription: Prescrição médica sugerida (medicamentos com dosagem, via de administração, frequência e duração - use nomenclatura técnica adequada)
        
        4. hypotheses: Array de hipóteses diagnósticas diferenciais, cada uma com:
           - condition: nome da condição
           - probability: probabilidade (0-100)
           - reasoning: justificativa
           - ministryGuidelines: referência às diretrizes do MS quando aplicável
        
        5. recommendations: Recomendações adicionais (exames complementares, sinais de alerta, quando procurar pronto-socorro)
        
        Use terminologia médica apropriada e siga as diretrizes do Ministério da Saúde e protocolos clínicos brasileiros.
        Responda APENAS com o objeto JSON válido.
      `;

      const result = await generateWithJSON(prompt);
      
      return {
        diagnosis: result.diagnosis || '',
        treatment: result.treatment || '',
        prescription: result.prescription || '',
        hypotheses: result.hypotheses || [],
        recommendations: result.recommendations || ''
      };
    } catch (error) {
      console.error('Gemini medical record analysis error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Failed to analyze symptoms for medical record'
      });
      throw error;
    }
  }

  async transcribeAndSummarizeConsultation(audioTranscript: string): Promise<{
    summary: string;
    keyPoints: string[];
    diagnosis?: string;
    treatment?: string;
    followUp?: string;
  }> {
    try {
      const prompt = `
        Analise esta transcrição de consulta médica e forneça um resumo estruturado:
        
        Transcrição: "${audioTranscript}"
        
        Forneça um resumo em JSON com:
        - summary: resumo geral da consulta
        - keyPoints: array com pontos-chave discutidos
        - diagnosis: diagnóstico mencionado (se houver)
        - treatment: tratamento prescrito (se houver)
        - followUp: orientações de acompanhamento (se houver)
      `;

      return await generateWithJSON(prompt);
    } catch (error) {
      console.error('Gemini transcription error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Failed to process consultation transcription'
      });
      throw error;
    }
  }

  async answerClinicalQuestion(question: string, context?: string): Promise<string> {
    try {
      const prompt = `
        Pergunta: "${question}"
        ${context ? `Contexto adicional: ${context}` : ''}
        
        Forneça uma resposta clara, precisa e baseada em evidências científicas. Sempre cite as fontes quando possível e lembre o paciente de que esta resposta não substitui uma consulta médica presencial.
      `;

      const systemInstruction = "Você é um assistente médico especializado que responde dúvidas clínicas baseado exclusivamente nas diretrizes do Ministério da Saúde brasileiro e protocolos clínicos oficiais. Sempre seja preciso e responsável em suas respostas.";

      return await generateText(prompt, systemInstruction);
    } catch (error) {
      console.error('Gemini clinical question error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Failed to process clinical question'
      });
      return `Desculpe, não foi possível processar sua pergunta médica no momento. Por favor, consulte diretamente com nossos profissionais de saúde.`;
    }
  }

  async extractExamResults(rawExamData: string, examType: string): Promise<{
    structuredResults: Record<string, any>;
    abnormalValues: Array<{ parameter: string; value: string; reference: string; status: 'high' | 'low' }>;
    summary: string;
  }> {
    try {
      const prompt = `
        Extraia e estruture os dados deste exame médico:
        
        Tipo de exame: ${examType}
        Dados brutos: "${rawExamData}"
        
        Forneça um JSON com:
        - structuredResults: objeto com todos os parâmetros e valores
        - abnormalValues: array com valores fora da normalidade
        - summary: resumo dos principais achados
      `;

      return await generateWithJSON(prompt);
    } catch (error) {
      console.error('Gemini exam extraction error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Failed to extract exam results'
      });
      return {
        structuredResults: {},
        abnormalValues: [],
        summary: 'Erro ao processar resultados do exame',
      };
    }
  }

  async generateClinicalAnalysis(prompt: string): Promise<string> {
    try {
      const systemInstruction = "You are a medical AI assistant specialized in generating SOAP reports for Brazilian healthcare (SUS). Always respond in Portuguese and follow medical documentation standards.";
      
      return await generateText(prompt, systemInstruction);
    } catch (error) {
      console.error('Gemini clinical analysis error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Failed to generate clinical analysis'
      });
      return 'Erro ao gerar análise clínica. Tente novamente.';
    }
  }

  async transcribeAudio(audioBuffer: Buffer, mimeType: string): Promise<string> {
    try {
      console.log('Transcription requested - buffer size:', audioBuffer.length, 'type:', mimeType);
      
      // Gemini doesn't have built-in audio transcription like Whisper
      // This would require a separate transcription service
      return 'Transcrição de áudio solicitada. Implementação de transcrição pendente.';
      
    } catch (error) {
      console.error('Gemini transcription error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: 'Failed to transcribe audio'
      });
      return 'Erro ao transcrever áudio. Verifique o formato do arquivo.';
    }
  }

  async generatePatientSummary(patientHistory: any[], consultationNotes: any[]): Promise<string> {
    try {
      const historyText = patientHistory.map(h => 
        `${h.date}: ${h.condition || h.diagnosis || h.description}`
      ).join('\n');
      
      const notesText = consultationNotes.map(n => 
        `[${n.type}] ${n.note}`
      ).join('\n');

      const prompt = `
Analise o histórico médico e as anotações da consulta atual para gerar um resumo do paciente:

HISTÓRICO MÉDICO:
${historyText}

ANOTAÇÕES DA CONSULTA ATUAL:
${notesText}

Gere um resumo estruturado em português brasileiro incluindo:
1. Condições médicas relevantes
2. Evolução do quadro clínico
3. Padrões identificados
4. Recomendações para acompanhamento

Formato: texto corrido, máximo 300 palavras.
`;

      const systemInstruction = "You are a medical AI assistant specialized in patient summary generation for Brazilian healthcare.";
      
      return await generateText(prompt, systemInstruction);
    } catch (error) {
      console.error('Gemini patient summary error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Failed to generate patient summary'
      });
      return 'Erro ao gerar resumo do paciente.';
    }
  }

  async analyzeExamResults(
    examType: string,
    results: any,
    patientHistory: string
  ): Promise<{
    analysis: string;
    abnormalValues?: Array<{ parameter: string; value: string; status: 'high' | 'low'; severity: 'mild' | 'moderate' | 'severe' }>;
    recommendations: string[];
    followUpRequired: boolean;
  }> {
    try {
      const resultsText = typeof results === 'object' ? JSON.stringify(results, null, 2) : results.toString();
      
      const prompt = `
        Como médico especialista em análise laboratorial, analise os resultados do exame e forneça uma interpretação clínica completa.
        
        Tipo de exame: ${examType}
        Resultados: ${resultsText}
        Histórico do paciente: ${patientHistory}
        
        Forneça uma análise em JSON com:
        - analysis: interpretação detalhada dos resultados
        - abnormalValues: array de valores alterados com parameter, value, status (high/low), severity (mild/moderate/severe)
        - recommendations: array de recomendações clínicas
        - followUpRequired: boolean indicando se requer acompanhamento
        
        Base sua análise nas diretrizes do Ministério da Saúde brasileiro e valores de referência padrão.
      `;

      return await generateWithJSON(prompt);
    } catch (error) {
      console.error('Gemini exam analysis error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Failed to analyze exam results'
      });
      return {
        analysis: 'Não foi possível analisar os resultados do exame automaticamente.',
        recommendations: ['Consulte um médico para interpretação dos resultados'],
        followUpRequired: true
      };
    }
  }

  async analyzeDrugInteractions(medications: string[]): Promise<{
    hasInteractions: boolean;
    interactions: Array<{
      drug1: string;
      drug2: string;
      severity: 'mild' | 'moderate' | 'severe';
      description: string;
      recommendation: string;
    }>;
    summary: string;
  }> {
    try {
      const prompt = `
        Analise as possíveis interações medicamentosas entre os seguintes medicamentos:
        
        Medicamentos: ${medications.join(', ')}
        
        Forneça uma análise em JSON com:
        - hasInteractions: boolean indicando se há interações
        - interactions: array de objetos com:
          - drug1: primeiro medicamento
          - drug2: segundo medicamento
          - severity: gravidade (mild/moderate/severe)
          - description: descrição da interação
          - recommendation: recomendação clínica
        - summary: resumo geral das interações encontradas
        
        Base sua análise em guidelines médicos reconhecidos e literatura científica.
      `;

      return await generateWithJSON(prompt);
    } catch (error) {
      console.error('Gemini drug interaction analysis error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Failed to analyze drug interactions'
      });
      return {
        hasInteractions: false,
        interactions: [],
        summary: 'Erro ao analisar interações medicamentosas. Consulte um farmacêutico.',
      };
    }
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    return await generateText(prompt, systemInstruction);
  }

  async chatWithContext(
    userMessage: string,
    systemContext: string,
    conversationHistory: Array<{ role: string; content: string }>,
    userRole: 'patient' | 'doctor' | 'visitor' | 'admin' | 'researcher' = 'patient',
    userLocale?: string
  ): Promise<{ response: string; referencesUsed: string[]; sourceType: 'references' | 'evidence_based' | 'mixed' }> {
    try {
      const client = getGeminiClient();
      const model = client.getGenerativeModel({ 
        model: "gemini-2.5-flash"
      });

      const regionInfo = this.getRegionInfo(userLocale);

      let pdfReferences = '';
      let referencesUsed: string[] = [];
      let hasRelevantReferences = false;
      try {
        const messageLower = userMessage.toLowerCase();
        const medicalKeywords = [
          'dor', 'febre', 'tosse', 'náusea', 'vômito', 'diarreia', 'cefaleia', 
          'pressão', 'diabetes', 'hipertensão', 'covid', 'gripe', 'resfriado',
          'sintoma', 'diagnóstico', 'tratamento', 'medicamento', 'exame',
          'harrison', 'medicina interna', 'emergência', 'cardiovascular', 
          'respiratório', 'gastrointestinal', 'neurológico', 'infecção',
          'pain', 'fever', 'cough', 'headache', 'blood pressure', 'diagnosis',
          'treatment', 'medication', 'symptom', 'disease', 'infection'
        ];

        let references = await db.select()
          .from(chatbotReferences)
          .where(and(
            eq(chatbotReferences.isActive, true),
            sql`${userRole} = ANY(${chatbotReferences.allowedRoles})`
          ))
          .orderBy(sql`${chatbotReferences.priority} DESC`)
          .limit(10);

        const scoredReferences = references.map(ref => {
          let score = ref.priority || 1;
          
          if (ref.keywords && ref.keywords.length > 0) {
            const keywordMatches = ref.keywords.filter(kw => 
              messageLower.includes(kw.toLowerCase())
            ).length;
            score += keywordMatches * 10;
          }
          
          const titleLower = ref.title.toLowerCase();
          const contentLower = (ref.content || '').toLowerCase();
          
          medicalKeywords.forEach(keyword => {
            if (messageLower.includes(keyword)) {
              if (titleLower.includes(keyword)) score += 5;
              if (contentLower.includes(keyword)) score += 2;
            }
          });

          if ((titleLower.includes('harrison') || contentLower.includes('harrison')) &&
              (messageLower.includes('diagnóstico') || messageLower.includes('tratamento') || 
               messageLower.includes('sintoma') || messageLower.includes('doença'))) {
            score += 20;
          }
          
          return { ...ref, relevanceScore: score };
        });

        const topReferences = scoredReferences
          .sort((a, b) => b.relevanceScore - a.relevanceScore)
          .slice(0, 5);

        if (topReferences.length > 0) {
          hasRelevantReferences = true;
          pdfReferences = '\n\n═══════════════════════════════════════════\n';
          pdfReferences += '📚 REFERÊNCIAS MÉDICAS DO PROFISSIONAL\n';
          pdfReferences += '═══════════════════════════════════════════\n\n';
          pdfReferences += '⚠️ INSTRUÇÕES CRÍTICAS:\n';
          pdfReferences += '1. Use PRIORITARIAMENTE as informações destas referências para responder\n';
          pdfReferences += '2. Cite o nome da referência ao mencionar informações dela\n';
          pdfReferences += '3. Se a resposta não estiver completamente nas referências, complemente com fontes médicas baseadas em evidências (cite a fonte)\n';
          pdfReferences += '4. Priorize evidências científicas das referências sobre conhecimento geral\n\n';
          
          topReferences.forEach((ref, index) => {
            if (ref.pdfExtractedText || ref.content) {
              pdfReferences += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
              pdfReferences += `📖 REFERÊNCIA ${index + 1}: ${ref.title}\n`;
              pdfReferences += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
              pdfReferences += `📂 Categoria: ${ref.category}\n`;
              if (ref.source) {
                pdfReferences += `🔗 Fonte: ${ref.source}\n`;
              }
              if (ref.keywords && ref.keywords.length > 0) {
                pdfReferences += `🏷️  Palavras-chave: ${ref.keywords.join(', ')}\n`;
              }
              pdfReferences += `📊 Relevância: ${ref.relevanceScore}/100\n\n`;
              
              const content = ref.pdfExtractedText || ref.content;
              const maxLength = 3000;
              const truncatedContent = content.length > maxLength 
                ? content.substring(0, maxLength) + '\n\n[...conteúdo truncado...]' 
                : content;
              
              pdfReferences += `📄 CONTEÚDO:\n${truncatedContent}\n\n`;
              referencesUsed.push(ref.id);
            }
          });
          
          pdfReferences += '═══════════════════════════════════════════\n';
          pdfReferences += '📚 FIM DAS REFERÊNCIAS MÉDICAS\n';
          pdfReferences += '═══════════════════════════════════════════\n\n';
        }
      } catch (dbError) {
        console.error('Error fetching PDF references:', dbError);
      }

      let evidenceBasedInstructions = '';
      if (!hasRelevantReferences) {
        evidenceBasedInstructions = this.buildEvidenceBasedPrompt(userRole, regionInfo);
      }

      let fullPrompt = systemContext + '\n\n';
      
      fullPrompt += `🌍 REGIÃO DO USUÁRIO: ${regionInfo.regionName}\n`;
      fullPrompt += `📋 Diretrizes aplicáveis: ${regionInfo.guidelines}\n`;
      fullPrompt += `🗣️ Idioma preferido: ${regionInfo.language}\n\n`;

      if (pdfReferences) {
        fullPrompt += pdfReferences;
      }
      
      if (evidenceBasedInstructions) {
        fullPrompt += evidenceBasedInstructions;
      }
      
      const recentHistory = conversationHistory.slice(-5);
      if (recentHistory.length > 0) {
        fullPrompt += '══════════════════════════════════════\n';
        fullPrompt += '💬 HISTÓRICO DA CONVERSA\n';
        fullPrompt += '══════════════════════════════════════\n\n';
        recentHistory.forEach((msg) => {
          const role = msg.role === 'user' ? '👤 Usuário' : '🤖 Assistente';
          fullPrompt += `${role}: ${msg.content}\n\n`;
        });
        fullPrompt += '══════════════════════════════════════\n\n';
      }
      
      fullPrompt += `═══ 💬 NOVA PERGUNTA ═══\n${userMessage}\n\n═══ 🤖 SUA RESPOSTA ═══\n`;

      const result = await model.generateContent(fullPrompt);
      const responseText = result.response.text();
      
      if (referencesUsed.length > 0) {
        try {
          await Promise.all(referencesUsed.map(refId =>
            db.update(chatbotReferences)
              .set({
                lastUsed: new Date(),
                usageCount: sql`${chatbotReferences.usageCount} + 1`
              })
              .where(eq(chatbotReferences.id, refId))
          ));
        } catch (updateError) {
          console.error('Error updating reference usage:', updateError);
        }
      }
      
      const sourceType = hasRelevantReferences 
        ? (evidenceBasedInstructions ? 'mixed' : 'references') 
        : 'evidence_based';

      return {
        response: responseText,
        referencesUsed,
        sourceType
      };
    } catch (error) {
      console.error('Gemini chat error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Failed to generate chat response'
      });
      
      if (error instanceof Error && error.message.includes('GEMINI_API_KEY')) {
        return {
          response: 'Funcionalidade de IA temporariamente indisponível. Configure a GEMINI_API_KEY para usar este assistente.',
          referencesUsed: [],
          sourceType: 'evidence_based' as const
        };
      }
      
      return {
        response: 'Desculpe, houve um erro ao processar sua pergunta. Por favor, tente novamente.',
        referencesUsed: [],
        sourceType: 'evidence_based' as const
      };
    }
  }

  private getRegionInfo(userLocale?: string): { regionName: string; guidelines: string; language: string; emergencyNumbers: string } {
    const locale = (userLocale || 'pt-BR').toLowerCase();
    
    if (locale.startsWith('pt') || locale.includes('br')) {
      return {
        regionName: 'Brasil',
        guidelines: 'Ministério da Saúde do Brasil, ANVISA, Protocolos Clínicos e Diretrizes Terapêuticas (PCDT), Consensos da AMB/CFM, RENAME (Relação Nacional de Medicamentos Essenciais)',
        language: 'Português (Brasil)',
        emergencyNumbers: 'SAMU 192, Bombeiros 193, UPA, Pronto Socorro'
      };
    } else if (locale.startsWith('es') || locale.includes('ar') || locale.includes('mx') || locale.includes('co') || locale.includes('cl') || locale.includes('pe')) {
      const country = locale.includes('ar') ? 'Argentina' : locale.includes('mx') ? 'México' : locale.includes('co') ? 'Colombia' : locale.includes('cl') ? 'Chile' : locale.includes('pe') ? 'Perú' : 'Latinoamérica';
      return {
        regionName: country,
        guidelines: `Ministerio de Salud de ${country}, OPS/OMS, guías de práctica clínica nacionales`,
        language: 'Español',
        emergencyNumbers: locale.includes('ar') ? 'SAME 107' : locale.includes('mx') ? '911, Cruz Roja 065' : '911'
      };
    } else if (locale.startsWith('en') || locale.includes('us')) {
      return {
        regionName: 'United States',
        guidelines: 'CDC, FDA, NIH, AMA Clinical Guidelines, UpToDate, Cochrane Reviews',
        language: 'English',
        emergencyNumbers: '911, Poison Control 1-800-222-1222'
      };
    } else {
      return {
        regionName: 'Internacional',
        guidelines: 'OMS/WHO, Cochrane Reviews, PubMed/MEDLINE, UpToDate, BMJ Best Practice',
        language: 'Português (Brasil)',
        emergencyNumbers: 'Serviço de emergência local'
      };
    }
  }

  private buildEvidenceBasedPrompt(userRole: string, regionInfo: { regionName: string; guidelines: string; language: string; emergencyNumbers: string }): string {
    let prompt = '\n═══════════════════════════════════════════\n';
    prompt += '🔬 MODO: MEDICINA BASEADA EM EVIDÊNCIAS\n';
    prompt += '═══════════════════════════════════════════\n\n';
    prompt += 'Nenhuma referência médica específica foi encontrada para esta pergunta.\n';
    prompt += 'Utilize o seguinte protocolo para garantir respostas confiáveis:\n\n';

    prompt += '📋 PROTOCOLO DE VALIDAÇÃO:\n';
    prompt += '1. PRIORIZE fontes de alto nível de evidência:\n';
    prompt += `   - ${regionInfo.guidelines}\n`;
    prompt += '   - Revisões sistemáticas e meta-análises (Cochrane, PubMed)\n';
    prompt += '   - Ensaios clínicos randomizados publicados em revistas indexadas\n';
    prompt += '   - Guidelines internacionais (WHO, NICE, AHA, ESC)\n\n';

    prompt += '2. CITE SEMPRE a fonte da informação:\n';
    prompt += '   - Nome da diretriz, guideline ou estudo\n';
    prompt += '   - Ano de publicação (quando relevante)\n';
    prompt += '   - Organização responsável\n';
    prompt += '   Exemplo: "Segundo as Diretrizes Brasileiras de Hipertensão (2020, SBC)..."\n\n';

    prompt += '3. CLASSIFIQUE o nível de evidência quando possível:\n';
    prompt += '   - Forte (meta-análises, guidelines nacionais)\n';
    prompt += '   - Moderada (estudos clínicos, consensos de especialistas)\n';
    prompt += '   - Limitada (séries de casos, opinião de especialistas)\n\n';

    prompt += `4. CONTEXTUALIZE para a região: ${regionInfo.regionName}\n`;
    prompt += `   - Considere medicamentos disponíveis na região\n`;
    prompt += `   - Use protocolos e diretrizes locais quando disponíveis\n`;
    prompt += `   - Números de emergência: ${regionInfo.emergencyNumbers}\n\n`;

    if (userRole === 'doctor') {
      prompt += '5. NÍVEL TÉCNICO: Profissional médico\n';
      prompt += '   - Use terminologia médica apropriada\n';
      prompt += '   - Inclua CID-10 quando relevante\n';
      prompt += '   - Forneça posologias e esquemas terapêuticos baseados em evidências\n';
      prompt += '   - Mencione contraindicações e interações relevantes\n\n';
    } else if (userRole === 'patient') {
      prompt += '5. NÍVEL DE LINGUAGEM: Paciente\n';
      prompt += '   - Use linguagem acessível e clara\n';
      prompt += '   - Explique termos médicos quando usados\n';
      prompt += '   - Nunca faça diagnósticos - oriente a procurar avaliação médica\n';
      prompt += '   - Foque em orientações de autocuidado e sinais de alerta\n\n';
    } else {
      prompt += '5. NÍVEL DE LINGUAGEM: Visitante/Público geral\n';
      prompt += '   - Use linguagem simples e acessível\n';
      prompt += '   - Não faça diagnósticos nem prescreva medicamentos\n';
      prompt += '   - Oriente sobre quando procurar atendimento médico\n';
      prompt += '   - Incentive o cadastro na plataforma para atendimento completo\n\n';
    }

    prompt += '⚠️ TRANSPARÊNCIA:\n';
    prompt += '- Informe que esta resposta é baseada em fontes médicas de evidência\n';
    prompt += '- Se houver incerteza, diga explicitamente\n';
    prompt += '- Nunca invente dados ou estatísticas\n';
    prompt += '═══════════════════════════════════════════\n\n';

    return prompt;
  }
}

export const geminiService = new GeminiService();
